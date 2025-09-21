const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// VALIDATION RULES
// ================================

const createExpenseValidation = [
  body('expenseType')
    .isIn([
      'TRUCK_EXPENSE', 'TRANSPORT_EXPENSE', 'DISTRIBUTION_EXPENSE', 
      'WAREHOUSE_EXPENSE', 'FUEL_COST', 'MAINTENANCE', 'SALARY_WAGES', 
      'OPERATIONAL', 'SERVICE_CHARGE'
    ])
    .withMessage('Invalid expense type'),
  body('category')
    .isIn([
      'FUEL', 'MAINTENANCE', 'REPAIRS', 'INSURANCE', 'DRIVER_WAGES',
      'SERVICE_CHARGES', 'EQUIPMENT', 'UTILITIES', 'RENT', 'OFFICE_SUPPLIES',
      'MARKETING', 'TRANSPORT_SERVICE_FEE', 'OTHER'
    ])
    .withMessage('Invalid expense category'),
  body('amount')
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Amount must be a valid decimal with up to 2 decimal places'),
  body('description')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Description must not exceed 500 characters'),
  body('expenseDate')
    .isISO8601()
    .withMessage('Expense date must be a valid date'),
  body('locationId')
    .optional()
    .custom(validateCuid('location ID')),
  body('truckId')
    .optional()
    .isLength({ max: 20 })
    .withMessage('Truck ID must not exceed 20 characters'),
  body('referenceId')
    .optional()
    .custom(validateCuid('reference ID')),
  body('receiptNumber')
    .optional()
    .isLength({ max: 50 })
    .withMessage('Receipt number must not exceed 50 characters')
];

const approveExpenseValidation = [
  body('action')
    .isIn(['approve', 'reject'])
    .withMessage('Action must be either approve or reject'),
  body('comment')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Comment must not exceed 200 characters')
];

// ================================
// EXPENSE MANAGEMENT ROUTES
// ================================

// @route   POST /api/v1/expenses
// @desc    Create new expense entry
// @access  Private (All roles can create expenses)
router.post('/',
  createExpenseValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      expenseType,
      category,
      amount,
      description,
      referenceId,
      expenseDate,
      locationId,
      truckId,
      departmentId,
      receiptNumber,
      receiptUrl
    } = req.body;

    const userId = req.user.id;

    // Validate references if provided
    if (locationId) {
      const location = await prisma.location.findUnique({
        where: { id: locationId }
      });
      if (!location) {
        throw new NotFoundError('Location not found');
      }
    }

    if (truckId) {
      const truck = await prisma.truckCapacity.findUnique({
        where: { truckId }
      });
      if (!truck) {
        throw new NotFoundError('Truck not found');
      }
    }

    const expense = await prisma.expense.create({
      data: {
        expenseType,
        category,
        amount: parseFloat(amount),
        description,
        referenceId,
        expenseDate: new Date(expenseDate),
        locationId,
        truckId,
        departmentId,
        receiptNumber,
        receiptUrl,
        status: 'PENDING',
        createdBy: userId
      },
      include: {
        location: true,
        truck: true,
        createdByUser: {
          select: { username: true, role: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Expense created successfully',
      data: { expense }
    });
  })
);

// @route   GET /api/v1/expenses
// @desc    Get expenses with filtering and pagination
// @access  Private
router.get('/', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    expenseType,
    category,
    status,
    locationId,
    truckId,
    startDate,
    endDate,
    search,
    sortBy = 'expenseDate',
    sortOrder = 'desc'
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  // Build where clause
  const where = {};

  // Role-based filtering - non-admins see only their own expenses
  if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
    where.createdBy = req.user.id;
  }

  if (expenseType) where.expenseType = expenseType;
  if (category) where.category = category;
  if (status) where.status = status;
  if (locationId) where.locationId = locationId;
  if (truckId) where.truckId = truckId;

  if (startDate || endDate) {
    where.expenseDate = {};
    if (startDate) where.expenseDate.gte = new Date(startDate);
    if (endDate) where.expenseDate.lte = new Date(endDate);
  }

  if (search) {
    where.OR = [
      { description: { contains: search, mode: 'insensitive' } },
      { receiptNumber: { contains: search, mode: 'insensitive' } },
      { referenceId: { contains: search, mode: 'insensitive' } }
    ];
  }

  // Build orderBy clause
  const orderBy = {};
  orderBy[sortBy] = sortOrder;

  const [expenses, total] = await Promise.all([
    prisma.expense.findMany({
      where,
      include: {
        location: { select: { name: true } },
        truck: { select: { truckId: true } },
        createdByUser: { select: { username: true, role: true } },
        approver: { select: { username: true, role: true } }
      },
      orderBy,
      skip,
      take
    }),
    prisma.expense.count({ where })
  ]);

  // Calculate summary statistics
  const summary = await prisma.expense.aggregate({
    where,
    _sum: { amount: true },
    _count: { status: true }
  });

  // Get status breakdown
  const statusBreakdown = await prisma.expense.groupBy({
    by: ['status'],
    where,
    _sum: { amount: true },
    _count: { status: true }
  });

  res.json({
    success: true,
    data: {
      expenses,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      },
      summary: {
        totalAmount: summary._sum.amount || 0,
        totalCount: summary._count || 0,
        statusBreakdown
      }
    }
  });
}));

// @route   GET /api/v1/expenses/:id
// @desc    Get single expense
// @access  Private
router.get('/:id',
  param('id').custom(validateCuid('expense ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const where = { id };

    // Role-based access - non-admins can only see their own expenses
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.createdBy = req.user.id;
    }

    const expense = await prisma.expense.findFirst({
      where,
      include: {
        location: true,
        truck: true,
        createdByUser: {
          select: { username: true, role: true, email: true }
        },
        approver: {
          select: { username: true, role: true, email: true }
        }
      }
    });

    if (!expense) {
      throw new NotFoundError('Expense not found');
    }

    res.json({
      success: true,
      data: { expense }
    });
  })
);

// @route   PUT /api/v1/expenses/:id
// @desc    Update expense (only pending expenses can be updated by creator)
// @access  Private
router.put('/:id',
  param('id').custom(validateCuid('expense ID')),
  createExpenseValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;
    const userId = req.user.id;

    // Get existing expense
    const existingExpense = await prisma.expense.findUnique({
      where: { id }
    });

    if (!existingExpense) {
      throw new NotFoundError('Expense not found');
    }

    // Check permissions
    if (existingExpense.createdBy !== userId && 
        !req.user.role.includes('ADMIN') && 
        req.user.role !== 'SUPER_ADMIN') {
      throw new BusinessError('You can only modify your own expenses', 'ACCESS_DENIED');
    }

    // Can only update pending expenses
    if (existingExpense.status !== 'PENDING') {
      throw new BusinessError('Only pending expenses can be modified', 'EXPENSE_NOT_PENDING');
    }

    // Update expense
    const updatedExpense = await prisma.expense.update({
      where: { id },
      data: {
        ...updateData,
        amount: parseFloat(updateData.amount),
        expenseDate: new Date(updateData.expenseDate)
      },
      include: {
        location: true,
        truck: true,
        createdByUser: {
          select: { username: true, role: true }
        }
      }
    });

    // Log the change
    await logDataChange(
      userId,
      'expense',
      id,
      'UPDATE',
      existingExpense,
      updatedExpense,
      getClientIP(req)
    );

    res.json({
      success: true,
      message: 'Expense updated successfully',
      data: { expense: updatedExpense }
    });
  })
);

// @route   POST /api/v1/expenses/:id/approve
// @desc    Approve or reject expense (Admin only)
// @access  Private (Admin)
router.post('/:id/approve',
  param('id').custom(validateCuid('expense ID')),
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN']),
  approveExpenseValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { action, comment } = req.body;
    const userId = req.user.id;

    const expense = await prisma.expense.findUnique({
      where: { id },
      include: {
        createdByUser: {
          select: { username: true, email: true }
        }
      }
    });

    if (!expense) {
      throw new NotFoundError('Expense not found');
    }

    if (expense.status !== 'PENDING') {
      throw new BusinessError('Only pending expenses can be approved or rejected', 'EXPENSE_NOT_PENDING');
    }

    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    const approvalData = {
      status: newStatus,
      approvedBy: userId,
      approvedAt: new Date()
    };

    if (comment) {
      approvalData.description = `${expense.description || ''}\n\nApproval Comment: ${comment}`;
    }

    const updatedExpense = await prisma.expense.update({
      where: { id },
      data: approvalData,
      include: {
        location: true,
        truck: true,
        createdByUser: {
          select: { username: true, role: true }
        },
        approver: {
          select: { username: true, role: true }
        }
      }
    });

    res.json({
      success: true,
      message: `Expense ${action}d successfully`,
      data: { expense: updatedExpense }
    });
  })
);

// @route   DELETE /api/v1/expenses/:id
// @desc    Delete expense (only pending expenses by creator or admin)
// @access  Private
router.delete('/:id',
  param('id').custom(validateCuid('expense ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const expense = await prisma.expense.findUnique({
      where: { id }
    });

    if (!expense) {
      throw new NotFoundError('Expense not found');
    }

    // Check permissions
    if (expense.createdBy !== userId && 
        !req.user.role.includes('ADMIN') && 
        req.user.role !== 'SUPER_ADMIN') {
      throw new BusinessError('You can only delete your own expenses', 'ACCESS_DENIED');
    }

    // Can only delete pending expenses
    if (expense.status !== 'PENDING') {
      throw new BusinessError('Only pending expenses can be deleted', 'EXPENSE_NOT_PENDING');
    }

    await prisma.expense.delete({
      where: { id }
    });

    res.json({
      success: true,
      message: 'Expense deleted successfully'
    });
  })
);

// ================================
// EXPENSE ANALYTICS & REPORTS
// ================================

// @route   GET /api/v1/expenses/analytics/summary
// @desc    Get expense analytics summary
// @access  Private (Admin)
router.get('/analytics/summary',
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const { startDate, endDate, period = 'monthly' } = req.query;
    
    const where = {};
    if (startDate || endDate) {
      where.expenseDate = {};
      if (startDate) where.expenseDate.gte = new Date(startDate);
      if (endDate) where.expenseDate.lte = new Date(endDate);
    }

    const [
      totalExpenses,
      expensesByType,
      expensesByCategory,
      expensesByStatus,
      monthlyTrend,
      topExpenses
    ] = await Promise.all([
      // Total expenses summary
      prisma.expense.aggregate({
        where,
        _sum: { amount: true },
        _count: true,
        _avg: { amount: true }
      }),

      // Expenses by type
      prisma.expense.groupBy({
        by: ['expenseType'],
        where,
        _sum: { amount: true },
        _count: { expenseType: true }
      }),

      // Expenses by category
      prisma.expense.groupBy({
        by: ['category'],
        where,
        _sum: { amount: true },
        _count: { category: true },
        orderBy: { _sum: { amount: 'desc' } }
      }),

      // Expenses by status
      prisma.expense.groupBy({
        by: ['status'],
        where,
        _sum: { amount: true },
        _count: { status: true }
      }),

      // Monthly trend (last 12 months)
      prisma.$queryRaw`
        SELECT 
          DATE_TRUNC('month', expense_date) as month,
          SUM(amount) as total_amount,
          COUNT(*) as total_count,
          AVG(amount) as avg_amount
        FROM expenses
        WHERE expense_date >= NOW() - INTERVAL '12 months'
        AND status = 'APPROVED'
        GROUP BY DATE_TRUNC('month', expense_date)
        ORDER BY month DESC
      `,

      // Top 10 highest expenses
      prisma.expense.findMany({
        where: {
          ...where,
          status: 'APPROVED'
        },
        include: {
          location: { select: { name: true } },
          truck: { select: { truckId: true } },
          createdByUser: { select: { username: true } }
        },
        orderBy: { amount: 'desc' },
        take: 10
      })
    ]);

    res.json({
      success: true,
      data: {
        summary: {
          totalAmount: totalExpenses._sum.amount || 0,
          totalCount: totalExpenses._count || 0,
          averageAmount: totalExpenses._avg.amount || 0
        },
        breakdowns: {
          byType: expensesByType,
          byCategory: expensesByCategory,
          byStatus: expensesByStatus
        },
        trends: {
          monthly: monthlyTrend
        },
        topExpenses
      }
    });
  })
);

// @route   GET /api/v1/expenses/analytics/location/:locationId
// @desc    Get expense analytics for specific location
// @access  Private (Admin)
router.get('/analytics/location/:locationId',
  param('locationId').custom(validateCuid('location ID')),
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN']),
  asyncHandler(async (req, res) => {
    const { locationId } = req.params;
    const { startDate, endDate } = req.query;

    // Verify location exists
    const location = await prisma.location.findUnique({
      where: { id: locationId }
    });

    if (!location) {
      throw new NotFoundError('Location not found');
    }

    const where = { 
      locationId,
      status: 'APPROVED'
    };

    if (startDate || endDate) {
      where.expenseDate = {};
      if (startDate) where.expenseDate.gte = new Date(startDate);
      if (endDate) where.expenseDate.lte = new Date(endDate);
    }

    const [
      locationExpenses,
      expensesByCategory,
      monthlyTrend
    ] = await Promise.all([
      prisma.expense.aggregate({
        where,
        _sum: { amount: true },
        _count: true,
        _avg: { amount: true }
      }),

      prisma.expense.groupBy({
        by: ['category'],
        where,
        _sum: { amount: true },
        _count: { category: true },
        orderBy: { _sum: { amount: 'desc' } }
      }),

      prisma.$queryRaw`
        SELECT 
          DATE_TRUNC('month', expense_date) as month,
          SUM(amount) as total_amount,
          COUNT(*) as total_count
        FROM expenses
        WHERE location_id = ${locationId}
        AND status = 'APPROVED'
        AND expense_date >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', expense_date)
        ORDER BY month DESC
      `
    ]);

    res.json({
      success: true,
      data: {
        location,
        summary: {
          totalAmount: locationExpenses._sum.amount || 0,
          totalCount: locationExpenses._count || 0,
          averageAmount: locationExpenses._avg.amount || 0
        },
        categoryBreakdown: expensesByCategory,
        monthlyTrend
      }
    });
  })
);

// @route   GET /api/v1/expenses/analytics/truck/:truckId
// @desc    Get expense analytics for specific truck
// @access  Private (Admin)
router.get('/analytics/truck/:truckId',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  asyncHandler(async (req, res) => {
    const { truckId } = req.params;
    const { startDate, endDate } = req.query;

    // Verify truck exists
    const truck = await prisma.truckCapacity.findUnique({
      where: { truckId }
    });

    if (!truck) {
      throw new NotFoundError('Truck not found');
    }

    const where = { 
      truckId,
      status: 'APPROVED'
    };

    if (startDate || endDate) {
      where.expenseDate = {};
      if (startDate) where.expenseDate.gte = new Date(startDate);
      if (endDate) where.expenseDate.lte = new Date(endDate);
    }

    const [
      truckExpenses,
      expensesByCategory,
      monthlyTrend,
      recentExpenses
    ] = await Promise.all([
      prisma.expense.aggregate({
        where,
        _sum: { amount: true },
        _count: true,
        _avg: { amount: true }
      }),

      prisma.expense.groupBy({
        by: ['category'],
        where,
        _sum: { amount: true },
        _count: { category: true },
        orderBy: { _sum: { amount: 'desc' } }
      }),

      prisma.$queryRaw`
        SELECT 
          DATE_TRUNC('month', expense_date) as month,
          SUM(amount) as total_amount,
          COUNT(*) as total_count
        FROM expenses
        WHERE truck_id = ${truckId}
        AND status = 'APPROVED'
        AND expense_date >= NOW() - INTERVAL '6 months'
        GROUP BY DATE_TRUNC('month', expense_date)
        ORDER BY month DESC
      `,

      prisma.expense.findMany({
        where,
        include: {
          location: { select: { name: true } },
          createdByUser: { select: { username: true } }
        },
        orderBy: { expenseDate: 'desc' },
        take: 10
      })
    ]);

    res.json({
      success: true,
      data: {
        truck,
        summary: {
          totalAmount: truckExpenses._sum.amount || 0,
          totalCount: truckExpenses._count || 0,
          averageAmount: truckExpenses._avg.amount || 0
        },
        categoryBreakdown: expensesByCategory,
        monthlyTrend,
        recentExpenses
      }
    });
  })
);

// @route   POST /api/v1/expenses/bulk-approve
// @desc    Bulk approve expenses (Admin only)
// @access  Private (Admin)
router.post('/bulk-approve',
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN']),
  body('expenseIds').isArray().withMessage('Expense IDs must be an array'),
  body('expenseIds.*').custom(validateCuid('expense ID')),
  body('action').isIn(['approve', 'reject']).withMessage('Action must be approve or reject'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { expenseIds, action, comment } = req.body;
    const userId = req.user.id;

    // Validate all expenses exist and are pending
    const expenses = await prisma.expense.findMany({
      where: {
        id: { in: expenseIds },
        status: 'PENDING'
      }
    });

    if (expenses.length !== expenseIds.length) {
      throw new BusinessError('Some expenses not found or not pending', 'INVALID_EXPENSES');
    }

    const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
    
    const result = await prisma.expense.updateMany({
      where: {
        id: { in: expenseIds },
        status: 'PENDING'
      },
      data: {
        status: newStatus,
        approvedBy: userId,
        approvedAt: new Date()
      }
    });

    res.json({
      success: true,
      message: `${result.count} expenses ${action}d successfully`,
      data: { 
        processedCount: result.count,
        action: newStatus
      }
    });
  })
);

module.exports = router;