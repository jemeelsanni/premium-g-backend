const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// VALIDATION RULES
// ================================

const createTargetValidation = [
  body('year')
    .isInt({ min: 2020, max: 2030 })
    .withMessage('Year must be between 2020 and 2030'),
  body('month')
    .isInt({ min: 1, max: 12 })
    .withMessage('Month must be between 1 and 12'),
  body('totalPacksTarget')
    .isInt({ min: 1 })
    .withMessage('Total packs target must be a positive integer'),
  body('weeklyTargets')
    .isArray({ min: 4, max: 4 })
    .withMessage('Weekly targets must be an array of exactly 4 values'),
  body('weeklyTargets.*')
    .isInt({ min: 0 })
    .withMessage('Each weekly target must be a non-negative integer'),
  body('categoryTargets').optional().isObject().withMessage('Category targets must be an object'),
  body('categoryTargets.CSD').optional().isInt({ min: 0 }),
  body('categoryTargets.ED').optional().isInt({ min: 0 }),
  body('categoryTargets.WATER').optional().isInt({ min: 0 }),
  body('categoryTargets.JUICE').optional().isInt({ min: 0 }),
];

const updateWeeklyPerformanceValidation = [
  body('actualPacks')
    .isInt({ min: 0 })
    .withMessage('Actual packs must be a non-negative integer')
];

// ================================
// UTILITY FUNCTIONS
// ================================

const calculateWeekDates = (year, month, weekNumber) => {
  // Calculate week dates for a given year, month, and week number (1-4)
  const firstDayOfMonth = new Date(year, month - 1, 1);
  const lastDayOfMonth = new Date(year, month, 0);
  
  const totalDaysInMonth = lastDayOfMonth.getDate();
  const daysPerWeek = Math.ceil(totalDaysInMonth / 4);
  
  const startDay = (weekNumber - 1) * daysPerWeek + 1;
  const endDay = Math.min(weekNumber * daysPerWeek, totalDaysInMonth);
  
  return {
    start: new Date(year, month - 1, startDay),
    end: new Date(year, month - 1, endDay, 23, 59, 59)
  };
};

const updateWeeklyPerformanceFromSales = async (year, month) => {
  // Get the target for the month
  const target = await prisma.distributionTarget.findUnique({
    where: { year_month: { year, month } },
    include: { weeklyPerformances: true }
  });

  if (!target) return;

  // Update each week's performance based on actual sales
  for (let week = 1; week <= 4; week++) {
    const weekDates = calculateWeekDates(year, month, week);
    
    // Calculate actual sales for the week
    const weekSales = await prisma.distributionOrder.aggregate({
      where: {
        createdAt: {
          gte: weekDates.start,
          lte: weekDates.end
        },
        status: {
          in: ['DELIVERED', 'PARTIALLY_DELIVERED']
        }
      },
      _sum: { totalPacks: true }
    });

    const actualPacks = weekSales._sum.totalPacks || 0;
    const weeklyTarget = target.weeklyTargets[week - 1] || 0;
    const percentageAchieved = weeklyTarget > 0 ? (actualPacks / weeklyTarget) * 100 : 0;

    // Update or create weekly performance record
    await prisma.weeklyPerformance.upsert({
      where: {
        targetId_weekNumber: {
          targetId: target.id,
          weekNumber: week
        }
      },
      update: {
        actualPacks,
        percentageAchieved: parseFloat(percentageAchieved.toFixed(2))
      },
      create: {
        targetId: target.id,
        weekNumber: week,
        targetPacks: weeklyTarget,
        actualPacks,
        percentageAchieved: parseFloat(percentageAchieved.toFixed(2)),
        weekStartDate: weekDates.start,
        weekEndDate: weekDates.end
      }
    });
  }
};

// ================================
// TARGET MANAGEMENT ROUTES
// ================================

// @route   POST /api/v1/targets
// @desc    Set monthly distribution target (Admin only)
// @access  Private (Admin)
router.post('/',
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN']),
  createTargetValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { year, month, totalPacksTarget, weeklyTargets, categoryTargets } = req.body;

    // Validate that weekly targets sum up to total target
    const weeklySum = weeklyTargets.reduce((sum, target) => sum + target, 0);
    if (weeklySum !== totalPacksTarget) {
      throw new ValidationError('Weekly targets must sum up to total monthly target');
    }

    // Build category targets object (only include provided categories)
    const resolvedCategoryTargets = categoryTargets
      ? {
          CSD: categoryTargets.CSD !== undefined ? parseInt(categoryTargets.CSD) : 0,
          ED: categoryTargets.ED !== undefined ? parseInt(categoryTargets.ED) : 0,
          WATER: categoryTargets.WATER !== undefined ? parseInt(categoryTargets.WATER) : 0,
          JUICE: categoryTargets.JUICE !== undefined ? parseInt(categoryTargets.JUICE) : 0,
        }
      : null;

    // Create or update target
    const target = await prisma.distributionTarget.upsert({
      where: { year_month: { year, month } },
      update: {
        totalPacksTarget,
        weeklyTargets,
        ...(resolvedCategoryTargets !== null && { categoryTargets: resolvedCategoryTargets }),
      },
      create: {
        year,
        month,
        totalPacksTarget,
        weeklyTargets,
        ...(resolvedCategoryTargets !== null && { categoryTargets: resolvedCategoryTargets }),
      }
    });

    // Create initial weekly performance records
    const weeklyPerformances = [];
    for (let week = 1; week <= 4; week++) {
      const weekDates = calculateWeekDates(year, month, week);
      
      const performance = await prisma.weeklyPerformance.upsert({
        where: {
          targetId_weekNumber: {
            targetId: target.id,
            weekNumber: week
          }
        },
        update: {
          targetPacks: weeklyTargets[week - 1],
          weekStartDate: weekDates.start,
          weekEndDate: weekDates.end
        },
        create: {
          targetId: target.id,
          weekNumber: week,
          targetPacks: weeklyTargets[week - 1],
          weekStartDate: weekDates.start,
          weekEndDate: weekDates.end
        }
      });
      
      weeklyPerformances.push(performance);
    }

    // Update performance with actual sales data
    await updateWeeklyPerformanceFromSales(year, month);

    res.status(201).json({
      success: true,
      message: 'Monthly target set successfully',
      data: {
        target,
        weeklyPerformances
      }
    });
  })
);

// @route   GET /api/v1/targets
// @desc    Get distribution targets with filtering
// @access  Private (Distribution module access)
router.get('/',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const { year, month, page = 1, limit = 12 } = req.query;

    const where = {};
    if (year) where.year = parseInt(year);
    if (month) where.month = parseInt(month);

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const [targets, total] = await Promise.all([
      prisma.distributionTarget.findMany({
        where,
        include: {
          weeklyPerformances: {
            orderBy: { weekNumber: 'asc' }
          }
        },
        orderBy: [
          { year: 'desc' },
          { month: 'desc' }
        ],
        skip,
        take
      }),
      prisma.distributionTarget.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        targets,
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

// @route   GET /api/v1/targets/current
// @desc    Get current month's target and performance
// @access  Private (Distribution module access)
router.get('/current',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const target = await prisma.distributionTarget.findUnique({
      where: { 
        year_month: { 
          year: currentYear, 
          month: currentMonth 
        } 
      },
      include: {
        weeklyPerformances: {
          orderBy: { weekNumber: 'asc' }
        }
      }
    });

    if (!target) {
      return res.json({
        success: true,
        data: {
          message: 'No target set for current month',
          suggestion: 'Please set a monthly target first'
        }
      });
    }

    // Update performance with latest sales data
    await updateWeeklyPerformanceFromSales(currentYear, currentMonth);

    // Get updated performance data
    const updatedTarget = await prisma.distributionTarget.findUnique({
      where: { 
        year_month: { 
          year: currentYear, 
          month: currentMonth 
        } 
      },
      include: {
        weeklyPerformances: {
          orderBy: { weekNumber: 'asc' }
        }
      }
    });

    // Calculate overall performance
    const totalActualPacks = updatedTarget.weeklyPerformances.reduce(
      (sum, week) => sum + week.actualPacks, 0
    );
    const overallPercentageAchieved = updatedTarget.totalPacksTarget > 0 ? 
      (totalActualPacks / updatedTarget.totalPacksTarget) * 100 : 0;

    res.json({
      success: true,
      data: {
        target: updatedTarget,
        summary: {
          totalTarget: updatedTarget.totalPacksTarget,
          totalActual: totalActualPacks,
          percentageAchieved: parseFloat(overallPercentageAchieved.toFixed(2)),
          remainingTarget: updatedTarget.totalPacksTarget - totalActualPacks
        }
      }
    });
  })
);

// ================================
// PERFORMANCE TRACKING ROUTES
// ================================

// @route   GET /api/v1/performance/weekly
// @desc    Get weekly performance data
// @access  Private (Distribution module access)
router.get('/weekly',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const { year, month, week } = req.query;
    const currentDate = new Date();
    const currentYear = year ? parseInt(year) : currentDate.getFullYear();
    const currentMonth = month ? parseInt(month) : currentDate.getMonth() + 1;

    let where = {};
    
    if (week) {
      where.weekNumber = parseInt(week);
    }

    // Get target for the specified month
    const target = await prisma.distributionTarget.findUnique({
      where: { 
        year_month: { 
          year: currentYear, 
          month: currentMonth 
        } 
      }
    });

    if (!target) {
      throw new NotFoundError('No target found for the specified month');
    }

    where.targetId = target.id;

    const performances = await prisma.weeklyPerformance.findMany({
      where,
      include: {
        target: true
      },
      orderBy: { weekNumber: 'asc' }
    });

    // Update with latest sales data before returning
    await updateWeeklyPerformanceFromSales(currentYear, currentMonth);

    // Get fresh data after update
    const updatedPerformances = await prisma.weeklyPerformance.findMany({
      where,
      include: {
        target: true
      },
      orderBy: { weekNumber: 'asc' }
    });

    res.json({
      success: true,
      data: {
        year: currentYear,
        month: currentMonth,
        weeklyPerformances: updatedPerformances
      }
    });
  })
);

// @route   PUT /api/v1/performance/weekly/:id
// @desc    Manually update weekly performance (Admin only)
// @access  Private (Admin)
router.put('/weekly/:id',
  param('id').custom(validateCuid('performance ID')),
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN']),
  updateWeeklyPerformanceValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { actualPacks } = req.body;

    const performance = await prisma.weeklyPerformance.findUnique({
      where: { id },
      include: { target: true }
    });

    if (!performance) {
      throw new NotFoundError('Weekly performance record not found');
    }

    const percentageAchieved = performance.targetPacks > 0 ? 
      (actualPacks / performance.targetPacks) * 100 : 0;

    const updatedPerformance = await prisma.weeklyPerformance.update({
      where: { id },
      data: {
        actualPacks,
        percentageAchieved: parseFloat(percentageAchieved.toFixed(2))
      },
      include: { target: true }
    });

    res.json({
      success: true,
      message: 'Weekly performance updated successfully',
      data: { performance: updatedPerformance }
    });
  })
);

// @route   GET /api/v1/performance/dashboard
// @desc    Get performance dashboard data
// @access  Private (Distribution module access)
router.get('/dashboard',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;

    // Get current month's target and performance
    const currentTarget = await prisma.distributionTarget.findUnique({
      where: { 
        year_month: { 
          year: currentYear, 
          month: currentMonth 
        } 
      },
      include: {
        weeklyPerformances: {
          orderBy: { weekNumber: 'asc' }
        }
      }
    });

    // Update current month performance
    if (currentTarget) {
      await updateWeeklyPerformanceFromSales(currentYear, currentMonth);
    }

    // Get last 6 months performance
    const monthlyPerformance = await prisma.$queryRaw`
      SELECT 
        dt.year,
        dt.month,
        dt.total_packs_target,
        COALESCE(SUM(wp.actual_packs), 0) as total_actual_packs,
        CASE 
          WHEN dt.total_packs_target > 0 THEN 
            (COALESCE(SUM(wp.actual_packs), 0) * 100.0 / dt.total_packs_target)
          ELSE 0 
        END as percentage_achieved
      FROM distribution_targets dt
      LEFT JOIN weekly_performances wp ON dt.id = wp.target_id
      WHERE dt.year >= ${currentYear - 1}
      GROUP BY dt.id, dt.year, dt.month, dt.total_packs_target
      ORDER BY dt.year DESC, dt.month DESC
      LIMIT 6
    `;

    // Get top performing weeks
    const topPerformingWeeks = await prisma.weeklyPerformance.findMany({
      where: {
        percentageAchieved: { gt: 100 }
      },
      include: {
        target: true
      },
      orderBy: { percentageAchieved: 'desc' },
      take: 5
    });

    // Calculate current month summary
    let currentSummary = null;
    if (currentTarget) {
      const freshTarget = await prisma.distributionTarget.findUnique({
        where: { 
          year_month: { 
            year: currentYear, 
            month: currentMonth 
          } 
        },
        include: {
          weeklyPerformances: {
            orderBy: { weekNumber: 'asc' }
          }
        }
      });

      const totalActual = freshTarget.weeklyPerformances.reduce(
        (sum, week) => sum + week.actualPacks, 0
      );
      const overallPercentage = freshTarget.totalPacksTarget > 0 ? 
        (totalActual / freshTarget.totalPacksTarget) * 100 : 0;

      currentSummary = {
        year: currentYear,
        month: currentMonth,
        totalTarget: freshTarget.totalPacksTarget,
        totalActual,
        percentageAchieved: parseFloat(overallPercentage.toFixed(2)),
        weeklyBreakdown: freshTarget.weeklyPerformances.map(week => ({
          weekNumber: week.weekNumber,
          target: week.targetPacks,
          actual: week.actualPacks,
          percentage: week.percentageAchieved
        }))
      };
    }

    res.json({
      success: true,
      data: {
        currentMonth: currentSummary,
        monthlyTrend: monthlyPerformance,
        topPerformingWeeks,
        insights: {
          hasCurrentTarget: !!currentTarget,
          averageMonthlyAchievement: monthlyPerformance.length > 0 ? 
            monthlyPerformance.reduce((sum, month) => sum + parseFloat(month.percentage_achieved), 0) / monthlyPerformance.length : 0
        }
      }
    });
  })
);

// @route   POST /api/v1/performance/recalculate
// @desc    Recalculate all performance metrics (Admin only)
// @access  Private (Admin)
router.post('/recalculate',
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN']),
  asyncHandler(async (req, res) => {
    const { year, month } = req.body;

    if (year && month) {
      // Recalculate specific month
      await updateWeeklyPerformanceFromSales(year, month);
      res.json({
        success: true,
        message: `Performance recalculated for ${year}-${month.toString().padStart(2, '0')}`
      });
    } else {
      // Recalculate last 12 months
      const currentDate = new Date();
      const recalculatedMonths = [];

      for (let i = 0; i < 12; i++) {
        const date = new Date(currentDate);
        date.setMonth(date.getMonth() - i);
        const recalcYear = date.getFullYear();
        const recalcMonth = date.getMonth() + 1;

        await updateWeeklyPerformanceFromSales(recalcYear, recalcMonth);
        recalculatedMonths.push(`${recalcYear}-${recalcMonth.toString().padStart(2, '0')}`);
      }

      res.json({
        success: true,
        message: 'Performance recalculated for last 12 months',
        data: { recalculatedMonths }
      });
    }
  })
);

// @route   DELETE /api/v1/targets/:id
// @desc    Delete a distribution target
// @access  Private (Admin only)
router.delete('/:id',
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN']),
  param('id').custom(validateCuid('target ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const target = await prisma.distributionTarget.findUnique({
      where: { id }
    });

    if (!target) {
      throw new NotFoundError('Target not found');
    }

    // Delete target and its weekly performances (cascade)
    await prisma.distributionTarget.delete({
      where: { id }
    });

    res.json({
      success: true,
      message: 'Target deleted successfully'
    });
  })
);

module.exports = router;