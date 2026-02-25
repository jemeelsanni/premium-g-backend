// routes/supplier-targets.js
// Updated: Added progress calculation for supplier targets
const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { asyncHandler, ValidationError, NotFoundError } = require('../middleware/errorHandler');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = require('../lib/prisma');

// Authorization middleware for write operations (SUPER_ADMIN or DISTRIBUTION_ADMIN only)
const authorizeAdmin = (req, res, next) => {
  if (!['SUPER_ADMIN', 'DISTRIBUTION_ADMIN'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      message: 'Access denied. Only SUPER_ADMIN and DISTRIBUTION_ADMIN can manage supplier targets.'
    });
  }
  next();
};

// ==========================================
// GET /api/v1/supplier-targets
// Get all supplier targets (filterable by supplier, year, month)
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

    const [targets, total] = await Promise.all([
      prisma.supplierTarget.findMany({
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
      prisma.supplierTarget.count({ where })
    ]);

    console.log('[TARGETS API] Found', targets.length, 'targets, calculating progress...');

    // Calculate actual sales for each target
    const targetsWithProgress = await Promise.all(targets.map(async (target) => {
      // Get start and end dates for the target month
      const startDate = new Date(target.year, target.month - 1, 1);
      const endDate = new Date(target.year, target.month, 0, 23, 59, 59, 999);

      // Get all orders for this supplier in this period
      const orders = await prisma.distributionOrder.findMany({
        where: {
          supplierCompanyId: target.supplierCompanyId,
          createdAt: {
            gte: startDate,
            lte: endDate
          }
        },
        include: {
          orderItems: {
            select: {
              packs: true
            }
          }
        }
      });

      // Calculate total packs sold and weekly breakdown
      const actualPacks = orders.reduce((total, order) => {
        const orderPacks = order.orderItems.reduce((sum, item) => sum + item.packs, 0);
        return total + orderPacks;
      }, 0);

      // Calculate weekly actuals and daily actuals
      const weeklyActuals = { week1: 0, week2: 0, week3: 0, week4: 0 };
      const dailyActuals = {}; // { 1: packs, 2: packs, ... 31: packs }

      orders.forEach(order => {
        const orderDate = new Date(order.createdAt);
        const dayOfMonth = orderDate.getDate();
        const orderPacks = order.orderItems.reduce((sum, item) => sum + item.packs, 0);

        // Determine which week (1-7: week1, 8-14: week2, 15-21: week3, 22+: week4)
        if (dayOfMonth <= 7) weeklyActuals.week1 += orderPacks;
        else if (dayOfMonth <= 14) weeklyActuals.week2 += orderPacks;
        else if (dayOfMonth <= 21) weeklyActuals.week3 += orderPacks;
        else weeklyActuals.week4 += orderPacks;

        // Track daily actuals
        dailyActuals[dayOfMonth] = (dailyActuals[dayOfMonth] || 0) + orderPacks;
      });

      const percentageAchieved = target.totalPacksTarget > 0
        ? (actualPacks / target.totalPacksTarget) * 100
        : 0;

      console.log(`[PROGRESS] Target ${target.id}: ${actualPacks} packs / ${target.totalPacksTarget} = ${percentageAchieved.toFixed(1)}%`);

      return {
        ...target,
        actualPacks,
        weeklyActuals,
        dailyActuals,
        percentageAchieved: Math.round(percentageAchieved * 10) / 10,
        remainingTarget: Math.max(0, target.totalPacksTarget - actualPacks)
      };
    }));

    console.log('[TARGETS API] Returning', targetsWithProgress.length, 'targets with progress data');

    res.json({
      success: true,
      data: {
        targets: targetsWithProgress,
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
// GET /api/v1/supplier-targets/supplier/:supplierId
// Get all targets for a specific supplier
// Access: All authenticated users
// ==========================================
router.get(
  '/supplier/:supplierId',
  authenticateToken,
  param('supplierId').custom(validateCuid('supplier ID')),
  asyncHandler(async (req, res) => {
    const { supplierId } = req.params;

    // Verify supplier exists
    const supplier = await prisma.supplierCompany.findUnique({
      where: { id: supplierId }
    });

    if (!supplier) {
      throw new NotFoundError('Supplier company not found');
    }

    const targets = await prisma.supplierTarget.findMany({
      where: { supplierCompanyId: supplierId },
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

    // Calculate actual sales for each target
    const targetsWithProgress = await Promise.all(targets.map(async (target) => {
      // Get start and end dates for the target month
      const startDate = new Date(target.year, target.month - 1, 1);
      const endDate = new Date(target.year, target.month, 0, 23, 59, 59, 999);

      // Get all orders for this supplier in this period
      const orders = await prisma.distributionOrder.findMany({
        where: {
          supplierCompanyId: target.supplierCompanyId,
          createdAt: {
            gte: startDate,
            lte: endDate
          }
        },
        include: {
          orderItems: {
            select: {
              packs: true
            }
          }
        }
      });

      // Calculate total packs sold and weekly breakdown
      const actualPacks = orders.reduce((total, order) => {
        const orderPacks = order.orderItems.reduce((sum, item) => sum + item.packs, 0);
        return total + orderPacks;
      }, 0);

      // Calculate weekly actuals and daily actuals
      const weeklyActuals = { week1: 0, week2: 0, week3: 0, week4: 0 };
      const dailyActuals = {}; // { 1: packs, 2: packs, ... 31: packs }

      orders.forEach(order => {
        const orderDate = new Date(order.createdAt);
        const dayOfMonth = orderDate.getDate();
        const orderPacks = order.orderItems.reduce((sum, item) => sum + item.packs, 0);

        // Determine which week (1-7: week1, 8-14: week2, 15-21: week3, 22+: week4)
        if (dayOfMonth <= 7) weeklyActuals.week1 += orderPacks;
        else if (dayOfMonth <= 14) weeklyActuals.week2 += orderPacks;
        else if (dayOfMonth <= 21) weeklyActuals.week3 += orderPacks;
        else weeklyActuals.week4 += orderPacks;

        // Track daily actuals
        dailyActuals[dayOfMonth] = (dailyActuals[dayOfMonth] || 0) + orderPacks;
      });

      const percentageAchieved = target.totalPacksTarget > 0
        ? (actualPacks / target.totalPacksTarget) * 100
        : 0;

      return {
        ...target,
        actualPacks,
        weeklyActuals,
        dailyActuals,
        percentageAchieved: Math.round(percentageAchieved * 10) / 10,
        remainingTarget: Math.max(0, target.totalPacksTarget - actualPacks)
      };
    }));

    res.json({
      success: true,
      data: {
        supplier,
        targets: targetsWithProgress
      }
    });
  })
);

// ==========================================
// GET /api/v1/supplier-targets/:id
// Get a specific supplier target by ID
// Access: All authenticated users
// ==========================================
router.get(
  '/:id',
  authenticateToken,
  param('id').custom(validateCuid('target ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const target = await prisma.supplierTarget.findUnique({
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

    if (!target) {
      throw new NotFoundError('Supplier target not found');
    }

    res.json({
      success: true,
      data: target
    });
  })
);

// ==========================================
// POST /api/v1/supplier-targets
// Create a new supplier target
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
    body('totalPacksTarget')
      .isInt({ min: 0 })
      .withMessage('Total packs target must be a positive integer'),
    body('weeklyTargets')
      .isObject()
      .withMessage('Weekly targets must be an object'),
    body('categoryTargets').optional().isObject().withMessage('Category targets must be an object'),
    body('categoryTargets.CSD').optional().isInt({ min: 0 }),
    body('categoryTargets.ED').optional().isInt({ min: 0 }),
    body('categoryTargets.WATER').optional().isInt({ min: 0 }),
    body('categoryTargets.JUICE').optional().isInt({ min: 0 }),
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
      totalPacksTarget,
      weeklyTargets,
      categoryTargets,
      notes
    } = req.body;

    // Verify supplier exists
    const supplier = await prisma.supplierCompany.findUnique({
      where: { id: supplierCompanyId }
    });

    if (!supplier) {
      throw new NotFoundError('Supplier company not found');
    }

    // Check if target already exists for this supplier/year/month
    const existing = await prisma.supplierTarget.findUnique({
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
        `Target for ${supplier.name} already exists for ${month}/${year}. Use update endpoint to modify.`
      );
    }

    // Build category targets object
    const resolvedCategoryTargets = categoryTargets
      ? {
          CSD: categoryTargets.CSD !== undefined ? parseInt(categoryTargets.CSD) : 0,
          ED: categoryTargets.ED !== undefined ? parseInt(categoryTargets.ED) : 0,
          WATER: categoryTargets.WATER !== undefined ? parseInt(categoryTargets.WATER) : 0,
          JUICE: categoryTargets.JUICE !== undefined ? parseInt(categoryTargets.JUICE) : 0,
        }
      : null;

    // Create target
    const target = await prisma.supplierTarget.create({
      data: {
        supplierCompanyId,
        year: parseInt(year),
        month: parseInt(month),
        totalPacksTarget: parseInt(totalPacksTarget),
        weeklyTargets,
        ...(resolvedCategoryTargets !== null && { categoryTargets: resolvedCategoryTargets }),
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
      message: `Target created for ${supplier.name} - ${month}/${year}`,
      data: target
    });
  })
);

// ==========================================
// PUT /api/v1/supplier-targets/:id
// Update a supplier target
// Access: SUPER_ADMIN, DISTRIBUTION_ADMIN only
// ==========================================
router.put(
  '/:id',
  authenticateToken,
  authorizeAdmin,
  [
    param('id').custom(validateCuid('target ID')),
    body('totalPacksTarget')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Total packs target must be a positive integer'),
    body('weeklyTargets')
      .optional()
      .isObject()
      .withMessage('Weekly targets must be an object'),
    body('categoryTargets').optional().isObject().withMessage('Category targets must be an object'),
    body('categoryTargets.CSD').optional().isInt({ min: 0 }),
    body('categoryTargets.ED').optional().isInt({ min: 0 }),
    body('categoryTargets.WATER').optional().isInt({ min: 0 }),
    body('categoryTargets.JUICE').optional().isInt({ min: 0 }),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { totalPacksTarget, weeklyTargets, categoryTargets, notes } = req.body;

    // Verify target exists
    const existing = await prisma.supplierTarget.findUnique({
      where: { id },
      include: {
        supplierCompany: {
          select: { name: true }
        }
      }
    });

    if (!existing) {
      throw new NotFoundError('Supplier target not found');
    }

    // Build update data
    const updateData = {};
    if (totalPacksTarget !== undefined) updateData.totalPacksTarget = parseInt(totalPacksTarget);
    if (weeklyTargets !== undefined) updateData.weeklyTargets = weeklyTargets;
    if (notes !== undefined) updateData.notes = notes || null;
    if (categoryTargets !== undefined) {
      updateData.categoryTargets = {
        CSD: categoryTargets.CSD !== undefined ? parseInt(categoryTargets.CSD) : 0,
        ED: categoryTargets.ED !== undefined ? parseInt(categoryTargets.ED) : 0,
        WATER: categoryTargets.WATER !== undefined ? parseInt(categoryTargets.WATER) : 0,
        JUICE: categoryTargets.JUICE !== undefined ? parseInt(categoryTargets.JUICE) : 0,
      };
    }

    // Update target
    const target = await prisma.supplierTarget.update({
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
      message: 'Supplier target updated successfully',
      data: target
    });
  })
);

// ==========================================
// DELETE /api/v1/supplier-targets/:id
// Delete a supplier target
// Access: SUPER_ADMIN, DISTRIBUTION_ADMIN only
// ==========================================
router.delete(
  '/:id',
  authenticateToken,
  authorizeAdmin,
  param('id').custom(validateCuid('target ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const target = await prisma.supplierTarget.findUnique({
      where: { id },
      include: {
        supplierCompany: {
          select: { name: true }
        }
      }
    });

    if (!target) {
      throw new NotFoundError('Supplier target not found');
    }

    await prisma.supplierTarget.delete({
      where: { id }
    });

    res.json({
      success: true,
      message: `Target for ${target.supplierCompany.name} (${target.month}/${target.year}) deleted successfully`
    });
  })
);

module.exports = router;
