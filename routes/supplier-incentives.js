// routes/supplier-incentives.js
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler, ValidationError, NotFoundError } = require('../middleware/errorHandler');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = require('../lib/prisma');

// Authorization middleware for write operations
const authorizeAdmin = (req, res, next) => {
  if (!['SUPER_ADMIN', 'DISTRIBUTION_ADMIN'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Only SUPER_ADMIN and DISTRIBUTION_ADMIN can manage supplier incentives.'
    });
  }
  next();
};

// ==========================================
// GET /api/v1/supplier-incentives
// Get all supplier incentives (filterable)
// Access: All authenticated users
// ==========================================
router.get(
  '/',
  authenticateToken,
  [
    query('supplierCompanyId').optional().custom(validateCuid('supplier company ID')),
    query('year').optional().isInt({ min: 2020, max: 2100 }),
    query('month').optional().isInt({ min: 1, max: 12 }),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const {
      supplierCompanyId,
      year,
      month,
      page = 1,
      limit = 20
    } = req.query;

    const where = {};
    if (supplierCompanyId) where.supplierCompanyId = supplierCompanyId;
    if (year) where.year = parseInt(year);
    if (month) where.month = parseInt(month);

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const [incentives, total] = await Promise.all([
      prisma.supplierIncentive.findMany({
        where,
        include: {
          supplierCompany: {
            select: {
              id: true,
              name: true,
              code: true
            }
          },
          creator: {
            select: {
              id: true,
              username: true,
              email: true
            }
          }
        },
        orderBy: [
          { year: 'desc' },
          { month: 'desc' }
        ],
        skip,
        take
      }),
      prisma.supplierIncentive.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        incentives,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  })
);

// ==========================================
// GET /api/v1/supplier-incentives/supplier/:supplierId
// Get all incentives for a specific supplier
// Access: All authenticated users
// ==========================================
router.get(
  '/supplier/:supplierId',
  authenticateToken,
  param('supplierId').custom(validateCuid('supplier ID')),
  asyncHandler(async (req, res) => {
    const { supplierId } = req.params;
    const { year, month } = req.query;

    // Verify supplier exists
    const supplier = await prisma.supplierCompany.findUnique({
      where: { id: supplierId }
    });

    if (!supplier) {
      throw new NotFoundError('Supplier company not found');
    }

    const where = { supplierCompanyId: supplierId };
    if (year) where.year = parseInt(year);
    if (month) where.month = parseInt(month);

    const incentives = await prisma.supplierIncentive.findMany({
      where,
      include: {
        creator: {
          select: {
            id: true,
            username: true,
            email: true
          }
        }
      },
      orderBy: [
        { year: 'desc' },
        { month: 'desc' }
      ]
    });

    // Calculate revenue for each incentive period
    const incentivesWithRevenue = await Promise.all(incentives.map(async (incentive) => {
      const startDate = new Date(incentive.year, incentive.month - 1, 1);
      const endDate = new Date(incentive.year, incentive.month, 0, 23, 59, 59, 999);

      // Get all orders for this supplier in this period
      const orders = await prisma.distributionOrder.findMany({
        where: {
          supplierCompanyId: incentive.supplierCompanyId,
          createdAt: {
            gte: startDate,
            lte: endDate
          }
        },
        include: {
          orderItems: {
            select: {
              amount: true
            }
          }
        }
      });

      // Calculate total revenue
      const totalRevenue = orders.reduce((total, order) => {
        const orderRevenue = order.orderItems.reduce((sum, item) => sum + parseFloat(item.amount || 0), 0);
        return total + orderRevenue;
      }, 0);

      // Calculate expected incentive
      const calculatedIncentive = (totalRevenue * incentive.incentivePercentage) / 100;

      // Calculate variance
      const variance = incentive.actualIncentivePaid 
        ? parseFloat(incentive.actualIncentivePaid) - calculatedIncentive
        : 0;

      const variancePercentage = calculatedIncentive > 0
        ? (variance / calculatedIncentive) * 100
        : 0;

      return {
        ...incentive,
        totalRevenue,
        calculatedIncentive,
        variance,
        variancePercentage: Math.round(variancePercentage * 10) / 10
      };
    }));

    res.json({
      success: true,
      data: {
        supplier,
        incentives: incentivesWithRevenue
      }
    });
  })
);

// ==========================================
// GET /api/v1/supplier-incentives/revenue/:supplierId
// Calculate revenue for a specific supplier and period
// Access: All authenticated users
// ==========================================
router.get(
  '/revenue/:supplierId',
  authenticateToken,
  [
    param('supplierId').custom(validateCuid('supplier ID')),
    query('year').isInt({ min: 2020, max: 2100 }).withMessage('Valid year is required'),
    query('month').isInt({ min: 1, max: 12 }).withMessage('Valid month (1-12) is required')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { supplierId } = req.params;
    const { year, month } = req.query;

    // Verify supplier exists
    const supplier = await prisma.supplierCompany.findUnique({
      where: { id: supplierId }
    });

    if (!supplier) {
      throw new NotFoundError('Supplier company not found');
    }

    // Calculate period boundaries
    const startDate = new Date(parseInt(year), parseInt(month) - 1, 1);
    const endDate = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59, 999);

    // Get all orders for this supplier in this period
    const orders = await prisma.distributionOrder.findMany({
      where: {
        supplierCompanyId: supplierId,
        createdAt: {
          gte: startDate,
          lte: endDate
        }
      },
      include: {
        orderItems: {
          select: {
            amount: true
          }
        }
      }
    });

    // Calculate total revenue
    const totalRevenue = orders.reduce((total, order) => {
      const orderRevenue = order.orderItems.reduce((sum, item) => sum + parseFloat(item.amount || 0), 0);
      return total + orderRevenue;
    }, 0);

    res.json({
      success: true,
      data: {
        supplierId,
        supplierName: supplier.name,
        year: parseInt(year),
        month: parseInt(month),
        totalRevenue,
        orderCount: orders.length
      }
    });
  })
);

// ==========================================
// GET /api/v1/supplier-incentives/monthly-revenue/:supplierId
// Get monthly revenue breakdown for a supplier (with date range filtering)
// Access: All authenticated users
// ==========================================
router.get(
  '/monthly-revenue/:supplierId',
  authenticateToken,
  [
    param('supplierId').custom(validateCuid('supplier ID')),
    query('startDate').optional().isISO8601().withMessage('Invalid start date'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date'),
    query('year').optional().isInt({ min: 2020, max: 2100 }).withMessage('Invalid year'),
    query('month').optional().isInt({ min: 1, max: 12 }).withMessage('Invalid month')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { supplierId } = req.params;
    const { startDate, endDate, year, month } = req.query;

    // Verify supplier exists
    const supplier = await prisma.supplierCompany.findUnique({
      where: { id: supplierId }
    });

    if (!supplier) {
      throw new NotFoundError('Supplier company not found');
    }

    // Build date filter
    let dateFilter = {};
    if (year && month) {
      // Specific month
      const start = new Date(parseInt(year), parseInt(month) - 1, 1);
      const end = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59, 999);
      dateFilter = { gte: start, lte: end };
    } else if (startDate && endDate) {
      // Date range
      dateFilter = { gte: new Date(startDate), lte: new Date(endDate) };
    } else if (startDate) {
      dateFilter = { gte: new Date(startDate) };
    } else if (endDate) {
      dateFilter = { lte: new Date(endDate) };
    }

    // Get all orders for this supplier
    const orders = await prisma.distributionOrder.findMany({
      where: {
        supplierCompanyId: supplierId,
        ...(Object.keys(dateFilter).length > 0 && { createdAt: dateFilter })
      },
      include: {
        orderItems: {
          select: {
            amount: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    // Group by month and calculate revenue
    const monthlyData = {};
    orders.forEach(order => {
      const orderDate = new Date(order.createdAt);
      const monthKey = `${orderDate.getFullYear()}-${String(orderDate.getMonth() + 1).padStart(2, '0')}`;

      if (!monthlyData[monthKey]) {
        monthlyData[monthKey] = {
          year: orderDate.getFullYear(),
          month: orderDate.getMonth() + 1,
          revenue: 0,
          orderCount: 0
        };
      }

      const orderRevenue = order.orderItems.reduce((sum, item) => sum + parseFloat(item.amount || 0), 0);
      monthlyData[monthKey].revenue += orderRevenue;
      monthlyData[monthKey].orderCount += 1;
    });

    // Convert to array and sort by date (newest first)
    const monthlyRevenue = Object.values(monthlyData).sort((a, b) => {
      if (b.year !== a.year) return b.year - a.year;
      return b.month - a.month;
    });

    // Calculate totals
    const totalRevenue = orders.reduce((total, order) => {
      const orderRevenue = order.orderItems.reduce((sum, item) => sum + parseFloat(item.amount || 0), 0);
      return total + orderRevenue;
    }, 0);

    res.json({
      success: true,
      data: {
        supplierId,
        supplierName: supplier.name,
        totalRevenue,
        totalOrders: orders.length,
        monthlyRevenue,
        filters: { startDate, endDate, year, month }
      }
    });
  })
);

// ==========================================
// GET /api/v1/supplier-incentives/:id
// Get a specific supplier incentive by ID
// Access: All authenticated users
// ==========================================
router.get(
  '/:id',
  authenticateToken,
  param('id').custom(validateCuid('incentive ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const incentive = await prisma.supplierIncentive.findUnique({
      where: { id },
      include: {
        supplierCompany: true,
        creator: {
          select: {
            id: true,
            username: true,
            email: true
          }
        }
      }
    });

    if (!incentive) {
      throw new NotFoundError('Supplier incentive not found');
    }

    res.json({
      success: true,
      data: incentive
    });
  })
);

// ==========================================
// POST /api/v1/supplier-incentives
// Create a new supplier incentive
// Access: SUPER_ADMIN, DISTRIBUTION_ADMIN only
// ==========================================
router.post(
  '/',
  authenticateToken,
  authorizeAdmin,
  [
    body('supplierCompanyId')
      .custom(validateCuid('supplier company ID'))
      .withMessage('Valid supplier company ID is required'),
    body('year')
      .isInt({ min: 2020, max: 2100 })
      .withMessage('Valid year is required'),
    body('month')
      .isInt({ min: 1, max: 12 })
      .withMessage('Valid month (1-12) is required'),
    body('incentivePercentage')
      .isFloat({ min: 0, max: 100 })
      .withMessage('Incentive percentage must be between 0 and 100'),
    body('actualIncentivePaid')
      .optional()
      .isDecimal()
      .withMessage('Actual incentive paid must be a valid decimal'),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      supplierCompanyId,
      year,
      month,
      incentivePercentage,
      actualIncentivePaid,
      notes
    } = req.body;

    // Verify supplier exists
    const supplier = await prisma.supplierCompany.findUnique({
      where: { id: supplierCompanyId }
    });

    if (!supplier) {
      throw new NotFoundError('Supplier company not found');
    }

    // Check if incentive already exists for this supplier/year/month
    const existing = await prisma.supplierIncentive.findUnique({
      where: {
        supplierCompanyId_year_month: {
          supplierCompanyId,
          year: parseInt(year),
          month: parseInt(month)
        }
      }
    });

    if (existing) {
      throw new ValidationError(
        `Incentive for ${supplier.name} already exists for ${month}/${year}. Use update endpoint to modify.`
      );
    }

    // Create incentive
    const incentive = await prisma.supplierIncentive.create({
      data: {
        supplierCompanyId,
        year: parseInt(year),
        month: parseInt(month),
        incentivePercentage: parseFloat(incentivePercentage),
        actualIncentivePaid: actualIncentivePaid ? parseFloat(actualIncentivePaid) : null,
        notes: notes || null,
        createdBy: req.user.id
      },
      include: {
        supplierCompany: {
          select: {
            id: true,
            name: true,
            code: true
          }
        },
        creator: {
          select: {
            id: true,
            username: true,
            email: true
          }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: `Incentive created for ${supplier.name} - ${month}/${year}`,
      data: incentive
    });
  })
);

// ==========================================
// PUT /api/v1/supplier-incentives/:id
// Update a supplier incentive
// Access: SUPER_ADMIN, DISTRIBUTION_ADMIN only
// ==========================================
router.put(
  '/:id',
  authenticateToken,
  authorizeAdmin,
  [
    param('id').custom(validateCuid('incentive ID')),
    body('incentivePercentage')
      .optional()
      .isFloat({ min: 0, max: 100 })
      .withMessage('Incentive percentage must be between 0 and 100'),
    body('actualIncentivePaid')
      .optional()
      .isDecimal()
      .withMessage('Actual incentive paid must be a valid decimal'),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { incentivePercentage, actualIncentivePaid, notes } = req.body;

    // Verify incentive exists
    const existing = await prisma.supplierIncentive.findUnique({
      where: { id },
      include: {
        supplierCompany: {
          select: { name: true }
        }
      }
    });

    if (!existing) {
      throw new NotFoundError('Supplier incentive not found');
    }

    // Build update data
    const updateData = {};
    if (incentivePercentage !== undefined) updateData.incentivePercentage = parseFloat(incentivePercentage);
    if (actualIncentivePaid !== undefined) updateData.actualIncentivePaid = actualIncentivePaid ? parseFloat(actualIncentivePaid) : null;
    if (notes !== undefined) updateData.notes = notes || null;

    // Update incentive
    const incentive = await prisma.supplierIncentive.update({
      where: { id },
      data: updateData,
      include: {
        supplierCompany: {
          select: {
            id: true,
            name: true,
            code: true
          }
        },
        creator: {
          select: {
            id: true,
            username: true,
            email: true
          }
        }
      }
    });

    res.json({
      success: true,
      message: 'Supplier incentive updated successfully',
      data: incentive
    });
  })
);

// ==========================================
// DELETE /api/v1/supplier-incentives/:id
// Delete a supplier incentive
// Access: SUPER_ADMIN, DISTRIBUTION_ADMIN only
// ==========================================
router.delete(
  '/:id',
  authenticateToken,
  authorizeAdmin,
  param('id').custom(validateCuid('incentive ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const incentive = await prisma.supplierIncentive.findUnique({
      where: { id },
      include: {
        supplierCompany: {
          select: { name: true }
        }
      }
    });

    if (!incentive) {
      throw new NotFoundError('Supplier incentive not found');
    }

    await prisma.supplierIncentive.delete({
      where: { id }
    });

    res.json({
      success: true,
      message: `Incentive for ${incentive.supplierCompany.name} (${incentive.month}/${incentive.year}) deleted successfully`
    });
  })
);

module.exports = router;
