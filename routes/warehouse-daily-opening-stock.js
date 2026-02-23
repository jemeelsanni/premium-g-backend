// routes/warehouse-daily-opening-stock.js
// Daily Opening Stock verification with approval workflow

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// VALIDATION RULES
// ================================

const submitDailyOpeningStockValidation = [
  body('productId')
    .notEmpty()
    .withMessage('Product ID is required')
    .custom(validateCuid('product ID')),
  body('stockDate')
    .isISO8601()
    .withMessage('Valid stock date is required (YYYY-MM-DD)'),
  body('manualPallets')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Manual pallets must be a non-negative integer'),
  body('manualPacks')
    .isInt({ min: 0 })
    .withMessage('Manual packs must be a non-negative integer'),
  body('manualUnits')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Manual units must be a non-negative integer'),
  body('notes').optional().trim()
];

const bulkSubmitValidation = [
  body('stockDate')
    .isISO8601()
    .withMessage('Valid stock date is required (YYYY-MM-DD)'),
  body('entries')
    .isArray({ min: 1 })
    .withMessage('At least one stock entry is required'),
  body('entries.*.productId')
    .notEmpty()
    .custom(validateCuid('product ID')),
  body('entries.*.manualPacks')
    .isInt({ min: 0 })
    .withMessage('Manual packs must be a non-negative integer')
];

const editRequestValidation = [
  body('newManualPallets')
    .optional()
    .isInt({ min: 0 }),
  body('newManualPacks')
    .isInt({ min: 0 })
    .withMessage('New manual packs must be a non-negative integer'),
  body('newManualUnits')
    .optional()
    .isInt({ min: 0 }),
  body('editReason')
    .notEmpty()
    .withMessage('Edit reason is required')
    .trim()
];

const approvalValidation = [
  body('approvalNotes').optional().trim()
];

const rejectionValidation = [
  body('rejectionReason')
    .notEmpty()
    .withMessage('Rejection reason is required')
    .trim()
];

// ================================
// HELPER FUNCTIONS
// ================================

/**
 * Get system opening stock for a product on a given date
 *
 * Opening stock for a date = Current Inventory
 *   - Purchases made on/after that date
 *   + Sales made on/after that date
 *
 * This works backwards from current inventory state
 */
async function getSystemOpeningStock(productId, stockDate) {
  const dateStart = new Date(stockDate);
  dateStart.setHours(0, 0, 0, 0);

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Get current inventory
  const currentInventory = await prisma.warehouseInventory.findFirst({
    where: { productId }
  });

  const currentPacks = currentInventory?.packs || 0;

  // If checking today's opening stock, use sum of quantityRemaining from active batches
  // This is more accurate as it reflects actual stock
  if (dateStart.getTime() === now.getTime()) {
    const activeBatches = await prisma.warehouseProductPurchase.aggregate({
      where: {
        productId,
        batchStatus: 'ACTIVE'
      },
      _sum: { quantityRemaining: true }
    });

    return {
      pallets: 0,
      packs: activeBatches._sum.quantityRemaining || currentPacks,
      units: 0
    };
  }

  // For past dates, calculate opening stock by working backwards
  // Opening Stock = Current Stock - Purchases since that date + Sales since that date

  // Get purchases made on or after the date
  const purchasesAfter = await prisma.warehouseProductPurchase.aggregate({
    where: {
      productId,
      purchaseDate: { gte: dateStart },
      batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
    },
    _sum: { quantity: true }
  });

  // Get sales made on or after the date
  const salesAfter = await prisma.warehouseSale.aggregate({
    where: {
      productId,
      createdAt: { gte: dateStart }
    },
    _sum: { quantity: true }
  });

  const totalPurchasedAfter = purchasesAfter._sum.quantity || 0;
  const totalSoldAfter = salesAfter._sum.quantity || 0;

  // Opening stock for that date = Current - Purchases after + Sales after
  const openingStock = currentPacks - totalPurchasedAfter + totalSoldAfter;

  return {
    pallets: 0,
    packs: Math.max(0, openingStock), // Ensure non-negative
    units: 0
  };
}

/**
 * Calculate variance value based on product cost
 */
async function calculateVarianceValue(productId, variancePacks) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { costPerPack: true }
  });

  if (!product || !product.costPerPack) {
    return 0;
  }

  return parseFloat(product.costPerPack) * variancePacks;
}

// ================================
// ROUTES - SALES REP (Submit)
// ================================

// @route   POST /api/v1/warehouse/daily-opening-stock
// @desc    Submit daily opening stock for a single product
// @access  Private (Warehouse module - write permission)
router.post('/',
  authorizeModule('warehouse', 'write'),
  submitDailyOpeningStockValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      productId,
      stockDate,
      manualPallets = 0,
      manualPacks,
      manualUnits = 0,
      notes
    } = req.body;

    // Verify product exists
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true, module: true }
    });

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    if (product.module !== 'WAREHOUSE' && product.module !== 'BOTH') {
      throw new BusinessError('This product is not in the warehouse module');
    }

    // Check if entry already exists for this product and date
    const dateOnly = new Date(stockDate);
    dateOnly.setHours(0, 0, 0, 0);

    const existing = await prisma.dailyOpeningStock.findUnique({
      where: {
        productId_stockDate: {
          productId,
          stockDate: dateOnly
        }
      }
    });

    if (existing) {
      throw new BusinessError(
        `Daily opening stock for ${product.name} on ${stockDate} has already been submitted. Use edit request to modify.`,
        'ALREADY_SUBMITTED'
      );
    }

    // Get system opening stock
    const systemStock = await getSystemOpeningStock(productId, stockDate);

    // Calculate variance
    const variancePallets = manualPallets - systemStock.pallets;
    const variancePacks = manualPacks - systemStock.packs;
    const varianceUnits = manualUnits - systemStock.units;

    // Calculate variance value
    const varianceValue = await calculateVarianceValue(productId, variancePacks);

    // Create the daily opening stock entry
    const dailyStock = await prisma.dailyOpeningStock.create({
      data: {
        productId,
        stockDate: dateOnly,
        manualPallets,
        manualPacks,
        manualUnits,
        systemPallets: systemStock.pallets,
        systemPacks: systemStock.packs,
        systemUnits: systemStock.units,
        variancePallets,
        variancePacks,
        varianceUnits,
        varianceValue,
        status: 'PENDING',
        submittedBy: req.user.id,
        notes
      },
      include: {
        product: {
          select: { id: true, name: true, productNo: true }
        },
        submitter: {
          select: { id: true, username: true, role: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Daily opening stock submitted for approval',
      data: dailyStock
    });
  })
);

// @route   POST /api/v1/warehouse/daily-opening-stock/bulk
// @desc    Submit daily opening stock for multiple products at once
// @access  Private (Warehouse module - write permission)
router.post('/bulk',
  authorizeModule('warehouse', 'write'),
  bulkSubmitValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { stockDate, entries } = req.body;
    const dateOnly = new Date(stockDate);
    dateOnly.setHours(0, 0, 0, 0);

    const results = {
      submitted: [],
      skipped: [],
      errors: []
    };

    for (const entry of entries) {
      try {
        // Check if already exists
        const existing = await prisma.dailyOpeningStock.findUnique({
          where: {
            productId_stockDate: {
              productId: entry.productId,
              stockDate: dateOnly
            }
          }
        });

        if (existing) {
          const product = await prisma.product.findUnique({
            where: { id: entry.productId },
            select: { name: true }
          });
          results.skipped.push({
            productId: entry.productId,
            productName: product?.name,
            reason: 'Already submitted for this date'
          });
          continue;
        }

        // Get system stock
        const systemStock = await getSystemOpeningStock(entry.productId, stockDate);

        const manualPallets = entry.manualPallets || 0;
        const manualPacks = entry.manualPacks || 0;
        const manualUnits = entry.manualUnits || 0;

        // Calculate variance
        const variancePacks = manualPacks - systemStock.packs;
        const varianceValue = await calculateVarianceValue(entry.productId, variancePacks);

        // Create entry
        const dailyStock = await prisma.dailyOpeningStock.create({
          data: {
            productId: entry.productId,
            stockDate: dateOnly,
            manualPallets,
            manualPacks,
            manualUnits,
            systemPallets: systemStock.pallets,
            systemPacks: systemStock.packs,
            systemUnits: systemStock.units,
            variancePallets: manualPallets - systemStock.pallets,
            variancePacks,
            varianceUnits: manualUnits - systemStock.units,
            varianceValue,
            status: 'PENDING',
            submittedBy: req.user.id,
            notes: entry.notes
          },
          include: {
            product: {
              select: { id: true, name: true, productNo: true }
            }
          }
        });

        results.submitted.push(dailyStock);
      } catch (error) {
        results.errors.push({
          productId: entry.productId,
          error: error.message
        });
      }
    }

    res.status(201).json({
      success: true,
      message: `Submitted ${results.submitted.length} entries, skipped ${results.skipped.length}`,
      data: results
    });
  })
);

// @route   GET /api/v1/warehouse/daily-opening-stock
// @desc    Get daily opening stock entries with filtering
// @access  Private (Warehouse module - read permission)
router.get('/',
  authorizeModule('warehouse'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED']),
    query('productId').optional().custom(validateCuid('product ID')),
    query('stockDate').optional().isISO8601(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('submittedBy').optional().custom(validateCuid('user ID'))
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const {
      page = 1,
      limit = 20,
      status,
      productId,
      stockDate,
      startDate,
      endDate,
      submittedBy
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build where clause
    const whereClause = {};

    if (status) whereClause.status = status;
    if (productId) whereClause.productId = productId;
    if (submittedBy) whereClause.submittedBy = submittedBy;

    if (stockDate) {
      const date = new Date(stockDate);
      date.setHours(0, 0, 0, 0);
      whereClause.stockDate = date;
    } else if (startDate || endDate) {
      whereClause.stockDate = {};
      if (startDate) {
        const start = new Date(startDate);
        start.setHours(0, 0, 0, 0);
        whereClause.stockDate.gte = start;
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        whereClause.stockDate.lte = end;
      }
    }

    const [total, entries] = await Promise.all([
      prisma.dailyOpeningStock.count({ where: whereClause }),
      prisma.dailyOpeningStock.findMany({
        where: whereClause,
        skip,
        take: parseInt(limit),
        orderBy: [{ stockDate: 'desc' }, { createdAt: 'desc' }],
        include: {
          product: {
            select: { id: true, name: true, productNo: true }
          },
          submitter: {
            select: { id: true, username: true, role: true }
          },
          approver: {
            select: { id: true, username: true, role: true }
          }
        }
      })
    ]);

    // Map entries to match frontend expectations
    const mappedEntries = entries.map(entry => ({
      ...entry,
      submittedByUser: entry.submitter,
      approvedByUser: entry.approver,
    }));

    res.json({
      success: true,
      data: {
        entries: mappedEntries,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  })
);

// @route   GET /api/v1/warehouse/daily-opening-stock/:id
// @desc    Get single daily opening stock entry
// @access  Private (Warehouse module - read permission)
router.get('/:id',
  authorizeModule('warehouse'),
  [param('id').custom(validateCuid('daily opening stock ID'))],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid ID', errors.array());
    }

    const entry = await prisma.dailyOpeningStock.findUnique({
      where: { id: req.params.id },
      include: {
        product: {
          select: { id: true, name: true, productNo: true, costPerPack: true }
        },
        submitter: {
          select: { id: true, username: true, role: true }
        },
        approver: {
          select: { id: true, username: true, role: true }
        },
        editRequests: {
          orderBy: { requestedAt: 'desc' },
          include: {
            requester: {
              select: { id: true, username: true, role: true }
            },
            approver: {
              select: { id: true, username: true, role: true }
            }
          }
        }
      }
    });

    if (!entry) {
      throw new NotFoundError('Daily opening stock entry not found');
    }

    res.json({
      success: true,
      data: entry
    });
  })
);

// ================================
// ROUTES - EDIT REQUEST
// ================================

// @route   POST /api/v1/warehouse/daily-opening-stock/:id/edit-request
// @desc    Request to edit an approved/rejected daily opening stock entry
// @access  Private (Warehouse module - write permission)
router.post('/:id/edit-request',
  authorizeModule('warehouse', 'write'),
  [param('id').custom(validateCuid('daily opening stock ID'))],
  editRequestValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { newManualPallets, newManualPacks, newManualUnits, editReason } = req.body;

    // Get the original entry
    const original = await prisma.dailyOpeningStock.findUnique({
      where: { id: req.params.id },
      include: { product: { select: { name: true } } }
    });

    if (!original) {
      throw new NotFoundError('Daily opening stock entry not found');
    }

    // Check for pending edit requests
    const pendingEdit = await prisma.dailyOpeningStockEditRequest.findFirst({
      where: {
        dailyOpeningStockId: req.params.id,
        status: 'PENDING'
      }
    });

    if (pendingEdit) {
      throw new BusinessError('There is already a pending edit request for this entry');
    }

    // Create edit request
    const editRequest = await prisma.dailyOpeningStockEditRequest.create({
      data: {
        dailyOpeningStockId: req.params.id,
        newManualPallets: newManualPallets ?? original.manualPallets,
        newManualPacks: newManualPacks ?? original.manualPacks,
        newManualUnits: newManualUnits ?? original.manualUnits,
        oldManualPallets: original.manualPallets,
        oldManualPacks: original.manualPacks,
        oldManualUnits: original.manualUnits,
        editReason,
        requestedBy: req.user.id,
        status: 'PENDING'
      },
      include: {
        dailyOpeningStock: {
          include: {
            product: { select: { id: true, name: true } }
          }
        },
        requester: {
          select: { id: true, username: true, role: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Edit request submitted for admin approval',
      data: editRequest
    });
  })
);

// @route   GET /api/v1/warehouse/daily-opening-stock/edit-requests
// @desc    Get all edit requests (for admin review)
// @access  Private (SUPER_ADMIN, WAREHOUSE_ADMIN, CASHIER)
router.get('/edit-requests/list',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'CASHIER']),
  [
    query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const whereClause = status ? { status } : {};

    const [total, requests] = await Promise.all([
      prisma.dailyOpeningStockEditRequest.count({ where: whereClause }),
      prisma.dailyOpeningStockEditRequest.findMany({
        where: whereClause,
        skip,
        take: parseInt(limit),
        orderBy: { requestedAt: 'desc' },
        include: {
          dailyOpeningStock: {
            include: {
              product: { select: { id: true, name: true, productNo: true } }
            }
          },
          requester: {
            select: { id: true, username: true, role: true }
          },
          approver: {
            select: { id: true, username: true, role: true }
          }
        }
      })
    ]);

    // Map requests to match frontend expectations
    const mappedRequests = requests.map(req => ({
      ...req,
      requestedByUser: req.requester,
      approvedByUser: req.approver,
    }));

    res.json({
      success: true,
      data: {
        editRequests: mappedRequests,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          totalPages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  })
);

// ================================
// ROUTES - ADMIN APPROVAL
// ================================

// @route   PUT /api/v1/warehouse/daily-opening-stock/:id/approve
// @desc    Approve daily opening stock entry
// @access  Private (SUPER_ADMIN, WAREHOUSE_ADMIN, CASHIER)
router.put('/:id/approve',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'CASHIER']),
  [param('id').custom(validateCuid('daily opening stock ID'))],
  approvalValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { approvalNotes } = req.body;

    const entry = await prisma.dailyOpeningStock.findUnique({
      where: { id: req.params.id },
      include: { product: { select: { name: true } } }
    });

    if (!entry) {
      throw new NotFoundError('Daily opening stock entry not found');
    }

    if (entry.status !== 'PENDING') {
      throw new BusinessError(`Cannot approve entry with status: ${entry.status}`);
    }

    const approved = await prisma.dailyOpeningStock.update({
      where: { id: req.params.id },
      data: {
        status: 'APPROVED',
        approvedBy: req.user.id,
        approvedAt: new Date(),
        approvalNotes
      },
      include: {
        product: { select: { id: true, name: true, productNo: true } },
        submitter: { select: { id: true, username: true } },
        approver: { select: { id: true, username: true } }
      }
    });

    res.json({
      success: true,
      message: 'Daily opening stock approved',
      data: approved
    });
  })
);

// @route   PUT /api/v1/warehouse/daily-opening-stock/:id/reject
// @desc    Reject daily opening stock entry
// @access  Private (SUPER_ADMIN, WAREHOUSE_ADMIN, CASHIER)
router.put('/:id/reject',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'CASHIER']),
  [param('id').custom(validateCuid('daily opening stock ID'))],
  rejectionValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { rejectionReason } = req.body;

    const entry = await prisma.dailyOpeningStock.findUnique({
      where: { id: req.params.id }
    });

    if (!entry) {
      throw new NotFoundError('Daily opening stock entry not found');
    }

    if (entry.status !== 'PENDING') {
      throw new BusinessError(`Cannot reject entry with status: ${entry.status}`);
    }

    const rejected = await prisma.dailyOpeningStock.update({
      where: { id: req.params.id },
      data: {
        status: 'REJECTED',
        approvedBy: req.user.id,
        approvedAt: new Date(),
        rejectionReason
      },
      include: {
        product: { select: { id: true, name: true, productNo: true } },
        submitter: { select: { id: true, username: true } },
        approver: { select: { id: true, username: true } }
      }
    });

    res.json({
      success: true,
      message: 'Daily opening stock rejected',
      data: rejected
    });
  })
);

// @route   PUT /api/v1/warehouse/daily-opening-stock/edit-requests/:id/approve
// @desc    Approve edit request and update the original entry
// @access  Private (SUPER_ADMIN, WAREHOUSE_ADMIN, CASHIER)
router.put('/edit-requests/:id/approve',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'CASHIER']),
  [param('id').custom(validateCuid('edit request ID'))],
  approvalValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { approvalNotes } = req.body;

    const editRequest = await prisma.dailyOpeningStockEditRequest.findUnique({
      where: { id: req.params.id },
      include: {
        dailyOpeningStock: true
      }
    });

    if (!editRequest) {
      throw new NotFoundError('Edit request not found');
    }

    if (editRequest.status !== 'PENDING') {
      throw new BusinessError(`Cannot approve request with status: ${editRequest.status}`);
    }

    // Update in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Update edit request status
      const approvedRequest = await tx.dailyOpeningStockEditRequest.update({
        where: { id: req.params.id },
        data: {
          status: 'APPROVED',
          approvedBy: req.user.id,
          approvedAt: new Date(),
          approvalNotes
        }
      });

      // Get system stock for recalculation
      const original = editRequest.dailyOpeningStock;
      const systemStock = await getSystemOpeningStock(original.productId, original.stockDate);

      // Calculate new variance
      const variancePacks = editRequest.newManualPacks - systemStock.packs;
      const varianceValue = await calculateVarianceValue(original.productId, variancePacks);

      // Update original entry with new values
      const updatedEntry = await tx.dailyOpeningStock.update({
        where: { id: original.id },
        data: {
          manualPallets: editRequest.newManualPallets,
          manualPacks: editRequest.newManualPacks,
          manualUnits: editRequest.newManualUnits,
          variancePallets: editRequest.newManualPallets - systemStock.pallets,
          variancePacks,
          varianceUnits: editRequest.newManualUnits - systemStock.units,
          varianceValue
        },
        include: {
          product: { select: { id: true, name: true, productNo: true } },
          submitter: { select: { id: true, username: true } }
        }
      });

      return { approvedRequest, updatedEntry };
    });

    res.json({
      success: true,
      message: 'Edit request approved and entry updated',
      data: result
    });
  })
);

// @route   PUT /api/v1/warehouse/daily-opening-stock/edit-requests/:id/reject
// @desc    Reject edit request
// @access  Private (SUPER_ADMIN, WAREHOUSE_ADMIN, CASHIER)
router.put('/edit-requests/:id/reject',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'CASHIER']),
  [param('id').custom(validateCuid('edit request ID'))],
  rejectionValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { rejectionReason } = req.body;

    const editRequest = await prisma.dailyOpeningStockEditRequest.findUnique({
      where: { id: req.params.id }
    });

    if (!editRequest) {
      throw new NotFoundError('Edit request not found');
    }

    if (editRequest.status !== 'PENDING') {
      throw new BusinessError(`Cannot reject request with status: ${editRequest.status}`);
    }

    const rejected = await prisma.dailyOpeningStockEditRequest.update({
      where: { id: req.params.id },
      data: {
        status: 'REJECTED',
        approvedBy: req.user.id,
        approvedAt: new Date(),
        rejectionReason
      },
      include: {
        dailyOpeningStock: {
          include: {
            product: { select: { id: true, name: true } }
          }
        },
        requester: { select: { id: true, username: true } }
      }
    });

    res.json({
      success: true,
      message: 'Edit request rejected',
      data: rejected
    });
  })
);

// ================================
// ROUTES - SUMMARY & REPORTS
// ================================

// @route   GET /api/v1/warehouse/daily-opening-stock/summary
// @desc    Get summary of daily opening stock status
// @access  Private (Warehouse module - read permission)
router.get('/summary/stats',
  authorizeModule('warehouse'),
  asyncHandler(async (req, res) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Calculate week start (Sunday)
    const weekStart = new Date(today);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const [
      todaySubmitted,
      todayPending,
      todayApproved,
      todayRejected,
      weekSubmitted,
      weekPending,
      weekApproved,
      weekRejected,
      pendingEditRequests
    ] = await Promise.all([
      // Today's stats
      prisma.dailyOpeningStock.count({
        where: { stockDate: { gte: today, lt: tomorrow } }
      }),
      prisma.dailyOpeningStock.count({
        where: { stockDate: { gte: today, lt: tomorrow }, status: 'PENDING' }
      }),
      prisma.dailyOpeningStock.count({
        where: { stockDate: { gte: today, lt: tomorrow }, status: 'APPROVED' }
      }),
      prisma.dailyOpeningStock.count({
        where: { stockDate: { gte: today, lt: tomorrow }, status: 'REJECTED' }
      }),
      // This week's stats
      prisma.dailyOpeningStock.count({
        where: { stockDate: { gte: weekStart } }
      }),
      prisma.dailyOpeningStock.count({
        where: { stockDate: { gte: weekStart }, status: 'PENDING' }
      }),
      prisma.dailyOpeningStock.count({
        where: { stockDate: { gte: weekStart }, status: 'APPROVED' }
      }),
      prisma.dailyOpeningStock.count({
        where: { stockDate: { gte: weekStart }, status: 'REJECTED' }
      }),
      // Pending edit requests
      prisma.dailyOpeningStockEditRequest.count({ where: { status: 'PENDING' } })
    ]);

    res.json({
      success: true,
      data: {
        today: {
          submitted: todaySubmitted,
          pending: todayPending,
          approved: todayApproved,
          rejected: todayRejected
        },
        thisWeek: {
          submitted: weekSubmitted,
          pending: weekPending,
          approved: weekApproved,
          rejected: weekRejected
        },
        pendingEditRequests
      }
    });
  })
);

// @route   GET /api/v1/warehouse/daily-opening-stock/comparison
// @desc    Get comparison between manual and system stock for a date
// @access  Private (Warehouse module - read permission)
router.get('/comparison/:date',
  authorizeModule('warehouse'),
  asyncHandler(async (req, res) => {
    const { date } = req.params;
    const stockDate = new Date(date);
    stockDate.setHours(0, 0, 0, 0);

    // Get all products to show comparison for all
    const allProducts = await prisma.warehouseProduct.findMany({
      select: { id: true, name: true, productNo: true },
      orderBy: { name: 'asc' }
    });

    // Get entries for this date
    const entries = await prisma.dailyOpeningStock.findMany({
      where: { stockDate },
      include: {
        product: {
          select: { id: true, name: true, productNo: true }
        }
      }
    });

    // Create a map for quick lookup
    const entriesMap = new Map(entries.map(e => [e.productId, e]));

    // Build comparison data
    const comparison = allProducts.map(product => {
      const entry = entriesMap.get(product.id);
      return {
        productId: product.id,
        productName: product.name,
        productNo: product.productNo,
        manual: entry ? {
          pallets: entry.manualPallets || 0,
          packs: entry.manualPacks || 0,
          units: entry.manualUnits || 0
        } : null,
        system: {
          pallets: entry?.systemPallets || 0,
          packs: entry?.systemPacks || 0,
          units: entry?.systemUnits || 0
        },
        variance: entry ? {
          pallets: entry.variancePallets || 0,
          packs: entry.variancePacks || 0,
          units: entry.varianceUnits || 0
        } : null,
        status: entry?.status || null,
        entryId: entry?.id || null
      };
    });

    // Calculate summary
    const submittedEntries = entries.length;
    const pendingCount = entries.filter(e => e.status === 'PENDING').length;
    const approvedCount = entries.filter(e => e.status === 'APPROVED').length;
    const rejectedCount = entries.filter(e => e.status === 'REJECTED').length;
    const productsWithVariance = entries.filter(e => e.variancePacks !== 0).length;

    res.json({
      success: true,
      data: {
        date: stockDate.toISOString().split('T')[0],
        comparison,
        summary: {
          totalProducts: allProducts.length,
          submittedCount: submittedEntries,
          pendingCount,
          approvedCount,
          rejectedCount,
          productsWithVariance
        }
      }
    });
  })
);

module.exports = router;
