// routes/warehouse-stock-count.js - Stock counting and verification management

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

const createStockCountValidation = [
  body('productId')
    .notEmpty()
    .withMessage('Product ID is required')
    .custom(validateCuid('product ID')),
  body('location').optional().trim(),
  body('countedPallets')
    .isInt({ min: 0 })
    .withMessage('Counted pallets must be a non-negative integer'),
  body('countedPacks')
    .isInt({ min: 0 })
    .withMessage('Counted packs must be a non-negative integer'),
  body('countedUnits')
    .isInt({ min: 0 })
    .withMessage('Counted units must be a non-negative integer'),
  body('countDate')
    .isISO8601()
    .withMessage('Valid count date is required'),
  body('notes').optional().trim()
];

const updateStockCountValidation = [
  body('countedPallets').optional().isInt({ min: 0 }),
  body('countedPacks').optional().isInt({ min: 0 }),
  body('countedUnits').optional().isInt({ min: 0 }),
  body('notes').optional().trim()
];

const approveStockCountValidation = [
  body('approvalNotes').optional().trim(),
  body('adjustmentReason').optional().trim()
];

const rejectStockCountValidation = [
  body('rejectionReason')
    .notEmpty()
    .withMessage('Rejection reason is required')
    .trim()
];

// ================================
// HELPER FUNCTIONS
// ================================

/**
 * Generate unique stock count number
 */
async function generateStockCountNumber() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');

  const prefix = `SC-${year}${month}${day}`;

  // Get the count of stock counts created today
  const count = await prisma.stockCount.count({
    where: {
      countNumber: {
        startsWith: prefix
      }
    }
  });

  const sequence = String(count + 1).padStart(4, '0');
  return `${prefix}-${sequence}`;
}

/**
 * Get current system stock for a product
 */
async function getSystemStock(productId, location = null) {
  const whereClause = {
    productId,
    ...(location && { location })
  };

  const inventory = await prisma.warehouseInventory.findFirst({
    where: whereClause
  });

  if (!inventory) {
    return {
      pallets: 0,
      packs: 0,
      units: 0
    };
  }

  return {
    pallets: inventory.pallets,
    packs: inventory.packs,
    units: inventory.units
  };
}

/**
 * Calculate variance between counted and system stock
 */
function calculateVariance(counted, system) {
  return {
    variancePallets: counted.pallets - system.pallets,
    variancePacks: counted.packs - system.packs,
    varianceUnits: counted.units - system.units
  };
}

/**
 * Calculate variance value based on product cost
 */
async function calculateVarianceValue(productId, variance) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { costPerPack: true, packsPerPallet: true }
  });

  if (!product || !product.costPerPack) {
    return 0;
  }

  const costPerPack = parseFloat(product.costPerPack);
  const packsPerPallet = product.packsPerPallet || 0;

  // Convert variance to packs
  const totalPacksVariance =
    (variance.variancePallets * packsPerPallet) +
    variance.variancePacks;

  return totalPacksVariance * costPerPack;
}

// ================================
// STOCK COUNT ROUTES
// ================================

// @route   POST /api/v1/warehouse/stock-counts
// @desc    Create new stock count (staff can create, requires admin approval)
// @access  Private (Warehouse module - write permission)
router.post('/stock-counts',
  authorizeModule('warehouse', 'write'),
  createStockCountValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { productId, location, countedPallets, countedPacks, countedUnits, countDate, notes } = req.body;

    // Verify product exists and is warehouse product
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        productNo: true,
        module: true,
        costPerPack: true,
        packsPerPallet: true
      }
    });

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    if (product.module !== 'WAREHOUSE' && product.module !== 'BOTH') {
      throw new BusinessError('This product is not available in the warehouse module');
    }

    // Get current system stock
    const systemStock = await getSystemStock(productId, location);

    // Calculate variance
    const countedStock = {
      pallets: countedPallets,
      packs: countedPacks,
      units: countedUnits
    };

    const variance = calculateVariance(countedStock, systemStock);

    // Calculate variance value
    const varianceValue = await calculateVarianceValue(productId, variance);

    // Generate count number
    const countNumber = await generateStockCountNumber();

    // Create stock count
    const stockCount = await prisma.stockCount.create({
      data: {
        countNumber,
        productId,
        location,
        countedPallets,
        countedPacks,
        countedUnits,
        systemPallets: systemStock.pallets,
        systemPacks: systemStock.packs,
        systemUnits: systemStock.units,
        variancePallets: variance.variancePallets,
        variancePacks: variance.variancePacks,
        varianceUnits: variance.varianceUnits,
        varianceValue,
        status: 'PENDING',
        countedBy: req.user.id,
        countDate: new Date(countDate),
        notes
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            productNo: true
          }
        },
        countedByUser: {
          select: {
            id: true,
            username: true,
            role: true
          }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Stock count created successfully and submitted for approval',
      data: stockCount
    });
  })
);

// @route   GET /api/v1/warehouse/stock-counts
// @desc    Get all stock counts with filtering and pagination
// @access  Private (Warehouse module - read permission)
router.get('/stock-counts',
  authorizeModule('warehouse'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'ADJUSTED']),
    query('productId').optional().custom(validateCuid('product ID')),
    query('location').optional().trim(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601()
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
      location,
      startDate,
      endDate
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build where clause
    const whereClause = {};

    if (status) {
      whereClause.status = status;
    }

    if (productId) {
      whereClause.productId = productId;
    }

    if (location) {
      whereClause.location = location;
    }

    if (startDate || endDate) {
      whereClause.countDate = {};
      if (startDate) {
        whereClause.countDate.gte = new Date(startDate);
      }
      if (endDate) {
        whereClause.countDate.lte = new Date(endDate);
      }
    }

    // Get total count and stock counts
    const [total, stockCounts] = await Promise.all([
      prisma.stockCount.count({ where: whereClause }),
      prisma.stockCount.findMany({
        where: whereClause,
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              productNo: true
            }
          },
          countedByUser: {
            select: {
              id: true,
              username: true,
              role: true
            }
          },
          approver: {
            select: {
              id: true,
              username: true,
              role: true
            }
          }
        }
      })
    ]);

    res.json({
      success: true,
      data: stockCounts,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  })
);

// @route   GET /api/v1/warehouse/stock-counts/:id
// @desc    Get single stock count by ID
// @access  Private (Warehouse module - read permission)
router.get('/stock-counts/:id',
  authorizeModule('warehouse'),
  [param('id').custom(validateCuid('stock count ID'))],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid stock count ID', errors.array());
    }

    const stockCount = await prisma.stockCount.findUnique({
      where: { id: req.params.id },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            productNo: true,
            costPerPack: true,
            packsPerPallet: true
          }
        },
        countedByUser: {
          select: {
            id: true,
            username: true,
            role: true
          }
        },
        approver: {
          select: {
            id: true,
            username: true,
            role: true
          }
        },
        adjustments: {
          include: {
            adjustedByUser: {
              select: {
                id: true,
                username: true,
                role: true
              }
            }
          }
        }
      }
    });

    if (!stockCount) {
      throw new NotFoundError('Stock count not found');
    }

    res.json({
      success: true,
      data: stockCount
    });
  })
);

// @route   PUT /api/v1/warehouse/stock-counts/:id
// @desc    Update stock count (only if status is PENDING)
// @access  Private (Warehouse module - write permission, own entry only)
router.put('/stock-counts/:id',
  authorizeModule('warehouse', 'write'),
  [param('id').custom(validateCuid('stock count ID'))],
  updateStockCountValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { countedPallets, countedPacks, countedUnits, notes } = req.body;

    // Check if stock count exists
    const existingCount = await prisma.stockCount.findUnique({
      where: { id: req.params.id }
    });

    if (!existingCount) {
      throw new NotFoundError('Stock count not found');
    }

    // Only allow updates for PENDING counts
    if (existingCount.status !== 'PENDING') {
      throw new BusinessError('Can only update stock counts with PENDING status');
    }

    // Only allow the creator or admins to update
    const isAdmin = ['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'CASHIER'].includes(req.user.role);
    if (existingCount.countedBy !== req.user.id && !isAdmin) {
      throw new BusinessError('You can only update your own stock counts');
    }

    // Prepare update data
    const updateData = {};

    if (notes !== undefined) {
      updateData.notes = notes;
    }

    // If counted values are being updated, recalculate variance
    if (countedPallets !== undefined || countedPacks !== undefined || countedUnits !== undefined) {
      const newCountedStock = {
        pallets: countedPallets !== undefined ? countedPallets : existingCount.countedPallets,
        packs: countedPacks !== undefined ? countedPacks : existingCount.countedPacks,
        units: countedUnits !== undefined ? countedUnits : existingCount.countedUnits
      };

      const systemStock = {
        pallets: existingCount.systemPallets,
        packs: existingCount.systemPacks,
        units: existingCount.systemUnits
      };

      const variance = calculateVariance(newCountedStock, systemStock);
      const varianceValue = await calculateVarianceValue(existingCount.productId, variance);

      updateData.countedPallets = newCountedStock.pallets;
      updateData.countedPacks = newCountedStock.packs;
      updateData.countedUnits = newCountedStock.units;
      updateData.variancePallets = variance.variancePallets;
      updateData.variancePacks = variance.variancePacks;
      updateData.varianceUnits = variance.varianceUnits;
      updateData.varianceValue = varianceValue;
    }

    const updatedCount = await prisma.stockCount.update({
      where: { id: req.params.id },
      data: updateData,
      include: {
        product: {
          select: {
            id: true,
            name: true,
            productNo: true
          }
        },
        countedByUser: {
          select: {
            id: true,
            username: true,
            role: true
          }
        }
      }
    });

    res.json({
      success: true,
      message: 'Stock count updated successfully',
      data: updatedCount
    });
  })
);

// @route   PUT /api/v1/warehouse/stock-counts/:id/approve
// @desc    Approve stock count and adjust inventory
// @access  Private (SUPER_ADMIN, WAREHOUSE_ADMIN, CASHIER only)
router.put('/stock-counts/:id/approve',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'CASHIER']),
  [param('id').custom(validateCuid('stock count ID'))],
  approveStockCountValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { approvalNotes, adjustmentReason } = req.body;

    // Get stock count
    const stockCount = await prisma.stockCount.findUnique({
      where: { id: req.params.id },
      include: {
        product: true
      }
    });

    if (!stockCount) {
      throw new NotFoundError('Stock count not found');
    }

    if (stockCount.status !== 'PENDING') {
      throw new BusinessError('Can only approve stock counts with PENDING status');
    }

    // Use transaction to approve and adjust inventory
    const result = await prisma.$transaction(async (tx) => {
      // 1. Update stock count status to APPROVED
      const approvedCount = await tx.stockCount.update({
        where: { id: req.params.id },
        data: {
          status: 'APPROVED',
          approvedBy: req.user.id,
          approvedAt: new Date(),
          approvalNotes,
          adjustmentReason
        },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              productNo: true
            }
          },
          countedByUser: {
            select: {
              id: true,
              username: true,
              role: true
            }
          },
          approver: {
            select: {
              id: true,
              username: true,
              role: true
            }
          }
        }
      });

      // 2. Check if there's a variance that requires adjustment
      const hasVariance =
        stockCount.variancePallets !== 0 ||
        stockCount.variancePacks !== 0 ||
        stockCount.varianceUnits !== 0;

      let adjustment = null;

      if (hasVariance) {
        // 3. Update the warehouse inventory
        const existingInventory = await tx.warehouseInventory.findFirst({
          where: {
            productId: stockCount.productId,
            location: stockCount.location
          }
        });

        if (existingInventory) {
          await tx.warehouseInventory.update({
            where: { id: existingInventory.id },
            data: {
              pallets: stockCount.countedPallets,
              packs: stockCount.countedPacks,
              units: stockCount.countedUnits
            }
          });
        } else {
          // Create new inventory record if none exists
          await tx.warehouseInventory.create({
            data: {
              productId: stockCount.productId,
              location: stockCount.location,
              pallets: stockCount.countedPallets,
              packs: stockCount.countedPacks,
              units: stockCount.countedUnits,
              reorderLevel: 0
            }
          });
        }

        // 4. Create stock adjustment record
        adjustment = await tx.stockAdjustment.create({
          data: {
            stockCountId: stockCount.id,
            productId: stockCount.productId,
            adjustmentPallets: stockCount.variancePallets,
            adjustmentPacks: stockCount.variancePacks,
            adjustmentUnits: stockCount.varianceUnits,
            beforePallets: stockCount.systemPallets,
            beforePacks: stockCount.systemPacks,
            beforeUnits: stockCount.systemUnits,
            afterPallets: stockCount.countedPallets,
            afterPacks: stockCount.countedPacks,
            afterUnits: stockCount.countedUnits,
            adjustmentValue: stockCount.varianceValue || 0,
            adjustmentReason: adjustmentReason || 'Stock count variance adjustment',
            adjustedBy: req.user.id
          },
          include: {
            adjustedByUser: {
              select: {
                id: true,
                username: true,
                role: true
              }
            }
          }
        });

        // 5. Update stock count status to ADJUSTED since we made changes
        await tx.stockCount.update({
          where: { id: req.params.id },
          data: { status: 'ADJUSTED' }
        });
      }

      return { approvedCount, adjustment, hasVariance };
    });

    const message = result.hasVariance
      ? 'Stock count approved and inventory adjusted successfully'
      : 'Stock count approved. No inventory adjustment needed (no variance)';

    res.json({
      success: true,
      message,
      data: {
        stockCount: result.approvedCount,
        adjustment: result.adjustment,
        inventoryAdjusted: result.hasVariance
      }
    });
  })
);

// @route   PUT /api/v1/warehouse/stock-counts/:id/reject
// @desc    Reject stock count
// @access  Private (SUPER_ADMIN, WAREHOUSE_ADMIN, CASHIER only)
router.put('/stock-counts/:id/reject',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'CASHIER']),
  [param('id').custom(validateCuid('stock count ID'))],
  rejectStockCountValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { rejectionReason } = req.body;

    // Get stock count
    const stockCount = await prisma.stockCount.findUnique({
      where: { id: req.params.id }
    });

    if (!stockCount) {
      throw new NotFoundError('Stock count not found');
    }

    if (stockCount.status !== 'PENDING') {
      throw new BusinessError('Can only reject stock counts with PENDING status');
    }

    // Update stock count status to REJECTED
    const rejectedCount = await prisma.stockCount.update({
      where: { id: req.params.id },
      data: {
        status: 'REJECTED',
        approvedBy: req.user.id,
        approvedAt: new Date(),
        rejectionReason
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            productNo: true
          }
        },
        countedByUser: {
          select: {
            id: true,
            username: true,
            role: true
          }
        },
        approver: {
          select: {
            id: true,
            username: true,
            role: true
          }
        }
      }
    });

    res.json({
      success: true,
      message: 'Stock count rejected',
      data: rejectedCount
    });
  })
);

// @route   DELETE /api/v1/warehouse/stock-counts/:id
// @desc    Delete stock count (only if status is PENDING or REJECTED)
// @access  Private (SUPER_ADMIN, WAREHOUSE_ADMIN only)
router.delete('/stock-counts/:id',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [param('id').custom(validateCuid('stock count ID'))],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid stock count ID', errors.array());
    }

    const stockCount = await prisma.stockCount.findUnique({
      where: { id: req.params.id }
    });

    if (!stockCount) {
      throw new NotFoundError('Stock count not found');
    }

    if (!['PENDING', 'REJECTED'].includes(stockCount.status)) {
      throw new BusinessError('Can only delete stock counts with PENDING or REJECTED status');
    }

    await prisma.stockCount.delete({
      where: { id: req.params.id }
    });

    res.json({
      success: true,
      message: 'Stock count deleted successfully'
    });
  })
);

// @route   GET /api/v1/warehouse/stock-counts/summary
// @desc    Get stock count summary statistics
// @access  Private (Warehouse module - read permission)
router.get('/stock-counts/summary',
  authorizeModule('warehouse'),
  asyncHandler(async (req, res) => {
    const [
      totalCounts,
      pendingCounts,
      approvedCounts,
      rejectedCounts,
      adjustedCounts,
      totalVarianceValue
    ] = await Promise.all([
      prisma.stockCount.count(),
      prisma.stockCount.count({ where: { status: 'PENDING' } }),
      prisma.stockCount.count({ where: { status: 'APPROVED' } }),
      prisma.stockCount.count({ where: { status: 'REJECTED' } }),
      prisma.stockCount.count({ where: { status: 'ADJUSTED' } }),
      prisma.stockCount.aggregate({
        where: { status: { in: ['APPROVED', 'ADJUSTED'] } },
        _sum: { varianceValue: true }
      })
    ]);

    res.json({
      success: true,
      data: {
        totalCounts,
        pendingCounts,
        approvedCounts,
        rejectedCounts,
        adjustedCounts,
        totalVarianceValue: totalVarianceValue._sum.varianceValue || 0
      }
    });
  })
);

module.exports = router;
