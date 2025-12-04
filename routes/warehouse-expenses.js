const express = require('express');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();
const prisma = require('../config/database');
const { authenticate, authorizeRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/asyncHandler');
const { 
  NotFoundError, 
  ValidationError, 
  BusinessError 
} = require('../utils/errors');
const { validateCuid } = require('../utils/validators');

// Apply authentication to all routes
router.use(authenticate);

// Validation rules
const createWarehouseExpenseValidation = [
  body('expenseType')
    .trim()
    .notEmpty()
    .withMessage('Expense type is required')
    .isIn([
      'UTILITIES', 
      'RENT', 
      'EQUIPMENT', 
      'SUPPLIES', 
      'MAINTENANCE',
      'INVENTORY_PROCUREMENT',
      'PACKAGING_MATERIALS',
      'SECURITY',
      'CLEANING_SERVICES',
      'INSURANCE',
      'OFFLOAD',
      'OTHER'
    ])
    .withMessage('Invalid expense type'),
  body('category')
    .trim()
    .notEmpty()
    .withMessage('Category is required')
    .isLength({ max: 100 })
    .withMessage('Category must not exceed 100 characters'),
  body('amount')
    .isFloat({ min: 0.01 })
    .withMessage('Amount must be greater than 0'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description must not exceed 500 characters'),
  body('receiptNumber')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Receipt number must not exceed 50 characters'),
  body('paymentMethod')
    .optional()
    .isIn(['CASH', 'BANK_TRANSFER', 'CHEQUE'])
    .withMessage('Invalid payment method'),
  body('productId')
    .optional()
    .custom(validateCuid('product ID'))
];

const updateWarehouseExpenseValidation = [
  body('expenseType')
    .optional()
    .trim()
    .isIn([
      'UTILITIES', 
      'RENT', 
      'EQUIPMENT', 
      'SUPPLIES', 
      'MAINTENANCE',
      'INVENTORY_PROCUREMENT',
      'PACKAGING_MATERIALS',
      'SECURITY',
      'CLEANING_SERVICES',
      'INSURANCE',
      'OFFLOAD',
      'OTHER'
    ])
    .withMessage('Invalid expense type'),
  body('category')
    .optional()
    .trim()
    .isLength({ max: 100 })
    .withMessage('Category must not exceed 100 characters'),
  body('amount')
    .optional()
    .isFloat({ min: 0.01 })
    .withMessage('Amount must be greater than 0'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description must not exceed 500 characters'),
  body('status')
    .optional()
    .isIn(['PENDING', 'APPROVED', 'REJECTED', 'PAID'])
    .withMessage('Invalid status'),
  body('rejectionReason')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Rejection reason must not exceed 500 characters'),
  body('receiptNumber')
    .optional()
    .trim()
    .isLength({ max: 50 })
    .withMessage('Receipt number must not exceed 50 characters'),
  body('paymentMethod')
    .optional()
    .isIn(['CASH', 'BANK_TRANSFER', 'CHEQUE'])
    .withMessage('Invalid payment method'),
  body('productId')
    .optional()
    .custom(validateCuid('product ID'))
];

// @route   GET /api/v1/warehouse/expenses
// @desc    Get all warehouse expenses with filters
// @access  Private (Warehouse Admin, Sales Officer, Super Admin)
router.get('/expenses',
  asyncHandler(async (req, res) => {
    const { 
      page = 1, 
      limit = 10, 
      status, 
      expenseType,
      startDate,
      endDate,
      search 
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // Build filter conditions
    const where = {};

    if (status) {
      where.status = status;
    }

    if (expenseType) {
      where.expenseType = expenseType;
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        where.createdAt.gte = new Date(startDate);
      }
      if (endDate) {
        where.createdAt.lte = new Date(endDate);
      }
    }

    if (search) {
      where.OR = [
        { category: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { receiptNumber: { contains: search, mode: 'insensitive' } }
      ];
    }

    // Role-based filtering
    if (!['SUPER_ADMIN', 'WAREHOUSE_ADMIN'].includes(req.user.role)) {
      where.createdBy = req.user.id;
    }

    const [expenses, total] = await Promise.all([
      prisma.warehouseExpense.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
        include: {
          product: {
            select: { 
              id: true,
              name: true, 
              productNo: true 
            }
          },
          createdByUser: {
            select: { 
              id: true,
              username: true,
              fullName: true
            }
          },
          approver: {
            select: { 
              id: true,
              username: true,
              fullName: true
            }
          }
        }
      }),
      prisma.warehouseExpense.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        expenses,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum)
        }
      }
    });
  })
);

// @route   POST /api/v1/warehouse/expenses
// @desc    Create new warehouse expense (auto-approve for WAREHOUSE_ADMIN)
// @access  Private (Warehouse Admin, Sales Officer, Super Admin)
router.post('/expenses',
  createWarehouseExpenseValidation,
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
      receiptNumber,
      paymentMethod,
      productId 
    } = req.body;

    // Validate product exists if provided
    if (productId) {
      const product = await prisma.product.findUnique({
        where: { id: productId }
      });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }
    }

    // ✨ Auto-approve if created by WAREHOUSE_ADMIN
    const isWarehouseAdmin = req.user.role === 'WAREHOUSE_ADMIN';
    
    const expenseData = {
      expenseType,
      category,
      amount,
      description: description || null,
      receiptNumber: receiptNumber || null,
      paymentMethod: paymentMethod || 'CASH',
      productId: productId || null,
      createdBy: req.user.id,
      status: isWarehouseAdmin ? 'APPROVED' : 'PENDING',
      approvedBy: isWarehouseAdmin ? req.user.id : null,
      approvedAt: isWarehouseAdmin ? new Date() : null
    };

    // Use transaction to create expense and cash flow together (if auto-approved)
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create the expense
      const expense = await tx.warehouseExpense.create({
        data: expenseData,
        include: {
          product: { 
            select: { 
              id: true,
              name: true, 
              productNo: true 
            } 
          },
          createdByUser: { 
            select: { 
              id: true,
              username: true,
              fullName: true
            } 
          },
          approver: { 
            select: { 
              id: true,
              username: true,
              fullName: true
            } 
          }
        }
      });

      let cashFlowEntry = null;

      // 2. ✨ AUTOMATICALLY CREATE CASH FLOW IF AUTO-APPROVED ✨
      if (isWarehouseAdmin) {
        const cashFlowDescription = expense.product
          ? `Expense: ${expense.category} - ${expense.product.name} (${expense.expenseType.replace(/_/g, ' ')})`
          : `Expense: ${expense.category} - ${expense.expenseType.replace(/_/g, ' ')}`;

        cashFlowEntry = await tx.cashFlow.create({
          data: {
            transactionType: 'CASH_OUT',
            amount: expense.amount,
            paymentMethod: expense.paymentMethod || 'CASH',
            description: cashFlowDescription,
            referenceNumber: expense.receiptNumber || `EXP-${expense.id.slice(0, 8)}`,
            cashier: req.user.id,
            module: 'WAREHOUSE'
          }
        });

        console.log('✅ Expense auto-approved and cash flow created:', {
          expenseId: expense.id,
          amount: expense.amount,
          category: expense.category,
          cashFlowId: cashFlowEntry.id
        });
      }

      return { expense, cashFlowEntry };
    });

    const message = isWarehouseAdmin 
      ? 'Warehouse expense created and automatically approved. Cash flow entry created.'
      : 'Warehouse expense created successfully and submitted for approval';

    res.status(201).json({
      success: true,
      message,
      data: { 
        expense: result.expense,
        cashFlowRecorded: isWarehouseAdmin,
        autoApproved: isWarehouseAdmin
      }
    });
  })
);

// @route   GET /api/v1/warehouse/expenses/:id
// @desc    Get single warehouse expense
// @access  Private (Warehouse Admin, creator, Super Admin)
router.get('/expenses/:id',
  param('id').custom(validateCuid('expense ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;

    const expense = await prisma.warehouseExpense.findUnique({
      where: { id },
      include: {
        product: { 
          select: { 
            id: true,
            name: true, 
            productNo: true 
          } 
        },
        createdByUser: { 
          select: { 
            id: true,
            username: true,
            fullName: true
          } 
        },
        approver: { 
          select: { 
            id: true,
            username: true,
            fullName: true
          } 
        }
      }
    });

    if (!expense) {
      throw new NotFoundError('Warehouse expense not found');
    }

    // Check permissions - only creator, warehouse admin, or super admin can view
    if (!['SUPER_ADMIN', 'WAREHOUSE_ADMIN'].includes(req.user.role) && 
        expense.createdBy !== req.user.id) {
      throw new BusinessError('Access denied', 'INSUFFICIENT_PERMISSIONS');
    }

    res.json({
      success: true,
      data: { expense }
    });
  })
);

// @route   PUT /api/v1/warehouse/expenses/:id
// @desc    Update warehouse expense (with automatic cash flow on approval)
// @access  Private (Warehouse Admin, Super Admin, or creator for pending expenses)
router.put('/expenses/:id',
  param('id').custom(validateCuid('expense ID')),
  updateWarehouseExpenseValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;

    const expense = await prisma.warehouseExpense.findUnique({
      where: { id },
      include: {
        product: { select: { id: true, name: true, productNo: true } },
        createdByUser: { select: { id: true, username: true, fullName: true } }
      }
    });

    if (!expense) {
      throw new NotFoundError('Warehouse expense not found');
    }

    // Check permissions
    const canUpdate = 
      ['SUPER_ADMIN', 'WAREHOUSE_ADMIN'].includes(req.user.role) ||
      (expense.createdBy === req.user.id && expense.status === 'PENDING');

    if (!canUpdate) {
      throw new BusinessError('Access denied', 'INSUFFICIENT_PERMISSIONS');
    }

    // Handle approval/rejection
    if (updateData.status && ['APPROVED', 'REJECTED'].includes(updateData.status)) {
      if (!['SUPER_ADMIN', 'WAREHOUSE_ADMIN'].includes(req.user.role)) {
        throw new BusinessError('Only administrators can approve/reject expenses', 'INSUFFICIENT_PERMISSIONS');
      }
      
      updateData.approvedBy = req.user.id;
      updateData.approvedAt = new Date();
    }

    // Handle payment
    if (updateData.status === 'PAID' && !expense.isPaid) {
      updateData.isPaid = true;
      updateData.paymentDate = new Date();
    }

    // Validate product if being updated
    if (updateData.productId) {
      const product = await prisma.product.findUnique({
        where: { id: updateData.productId }
      });
      
      if (!product) {
        throw new NotFoundError('Product not found');
      }
    }

    // ✨ Check if we need to create cash flow (expense is being approved)
    const isBeingApproved = updateData.status === 'APPROVED' && expense.status === 'PENDING';

    // Use transaction if creating cash flow
    const result = await prisma.$transaction(async (tx) => {
      // 1. Update the expense
      const updatedExpense = await tx.warehouseExpense.update({
        where: { id },
        data: updateData,
        include: {
          product: { select: { id: true, name: true, productNo: true } },
          createdByUser: { select: { id: true, username: true, fullName: true } },
          approver: { select: { id: true, username: true, fullName: true } }
        }
      });

      let cashFlowEntry = null;

      // 2. ✨ AUTOMATICALLY CREATE CASH FLOW ENTRY ON APPROVAL ✨
      if (isBeingApproved) {
        const cashFlowDescription = expense.product
          ? `Expense: ${expense.category} - ${expense.product.name} (${expense.expenseType.replace(/_/g, ' ')})`
          : `Expense: ${expense.category} - ${expense.expenseType.replace(/_/g, ' ')}`;

        cashFlowEntry = await tx.cashFlow.create({
          data: {
            transactionType: 'CASH_OUT',
            amount: expense.amount,
            paymentMethod: expense.paymentMethod || 'CASH',
            description: cashFlowDescription,
            referenceNumber: expense.receiptNumber || `EXP-${id.slice(0, 8)}`,
            cashier: req.user.id,
            module: 'WAREHOUSE'
          }
        });

        console.log('✅ Cash flow entry created for approved expense:', {
          transactionType: 'CASH_OUT',
          amount: expense.amount,
          expenseId: id,
          category: expense.category,
          cashFlowId: cashFlowEntry.id
        });
      }

      return { updatedExpense, cashFlowEntry };
    });

    const successMessage = isBeingApproved
      ? 'Warehouse expense approved successfully. Cash flow entry created.'
      : 'Warehouse expense updated successfully';

    res.json({
      success: true,
      message: successMessage,
      data: { 
        expense: result.updatedExpense,
        cashFlowRecorded: isBeingApproved
      }
    });
  })
);

// @route   POST /api/v1/warehouse/expenses/bulk-approve
// @desc    Bulk approve warehouse expenses (with automatic cash flow)
// @access  Private (Warehouse Admin, Super Admin)
router.post('/expenses/bulk-approve',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [
    body('expenseIds').isArray({ min: 1 }).withMessage('Expense IDs array is required'),
    body('action').isIn(['approve', 'reject']).withMessage('Action must be approve or reject'),
    body('rejectionReason').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { expenseIds, action, rejectionReason } = req.body;

    const updateData = {
      status: action === 'approve' ? 'APPROVED' : 'REJECTED',
      approvedBy: req.user.id,
      approvedAt: new Date()
    };

    if (action === 'reject' && rejectionReason) {
      updateData.rejectionReason = rejectionReason;
    }

    // Get all expenses to be updated
    const expenses = await prisma.warehouseExpense.findMany({
      where: {
        id: { in: expenseIds },
        status: 'PENDING'
      },
      include: {
        product: { select: { id: true, name: true, productNo: true } }
      }
    });

    if (expenses.length === 0) {
      throw new NotFoundError('No pending expenses found with provided IDs');
    }

    // Use transaction for bulk update and cash flow creation
    const result = await prisma.$transaction(async (tx) => {
      // Update all expenses
      const updatedExpenses = await tx.warehouseExpense.updateMany({
        where: {
          id: { in: expenses.map(e => e.id) }
        },
        data: updateData
      });

      const cashFlowEntries = [];

      // Create cash flow entries for approved expenses
      if (action === 'approve') {
        for (const expense of expenses) {
          const cashFlowDescription = expense.product
            ? `Expense: ${expense.category} - ${expense.product.name} (${expense.expenseType.replace(/_/g, ' ')})`
            : `Expense: ${expense.category} - ${expense.expenseType.replace(/_/g, ' ')}`;

          const cashFlowEntry = await tx.cashFlow.create({
            data: {
              transactionType: 'CASH_OUT',
              amount: expense.amount,
              paymentMethod: expense.paymentMethod || 'CASH',
              description: cashFlowDescription,
              referenceNumber: expense.receiptNumber || `EXP-${expense.id.slice(0, 8)}`,
              cashier: req.user.id,
              module: 'WAREHOUSE'
            }
          });

          cashFlowEntries.push(cashFlowEntry);
        }

        console.log(`✅ Bulk approved ${expenses.length} expenses with cash flow entries`);
      }

      return { updatedExpenses, cashFlowEntries };
    });

    const message = action === 'approve'
      ? `Successfully approved ${expenses.length} expense(s). Cash flow entries created.`
      : `Successfully rejected ${expenses.length} expense(s)`;

    res.json({
      success: true,
      message,
      data: {
        updated: result.updatedExpenses.count,
        cashFlowRecorded: action === 'approve'
      }
    });
  })
);

// @route   DELETE /api/v1/warehouse/expenses/:id
// @desc    Delete warehouse expense (only if pending)
// @access  Private (Warehouse Admin, Super Admin, or creator)
router.delete('/expenses/:id',
  param('id').custom(validateCuid('expense ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;

    const expense = await prisma.warehouseExpense.findUnique({
      where: { id }
    });

    if (!expense) {
      throw new NotFoundError('Warehouse expense not found');
    }

    // Only allow deletion of pending expenses
    if (expense.status !== 'PENDING') {
      throw new BusinessError(
        'Cannot delete expense that has been approved or rejected',
        'INVALID_OPERATION'
      );
    }

    // Check permissions
    const canDelete = 
      ['SUPER_ADMIN', 'WAREHOUSE_ADMIN'].includes(req.user.role) ||
      expense.createdBy === req.user.id;

    if (!canDelete) {
      throw new BusinessError('Access denied', 'INSUFFICIENT_PERMISSIONS');
    }

    await prisma.warehouseExpense.delete({
      where: { id }
    });

    res.json({
      success: true,
      message: 'Warehouse expense deleted successfully'
    });
  })
);

// @route   GET /api/v1/warehouse/expenses/stats/summary
// @desc    Get warehouse expenses summary statistics
// @access  Private (Warehouse Admin, Super Admin)
router.get('/expenses/stats/summary',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) {
        dateFilter.createdAt.gte = new Date(startDate);
      }
      if (endDate) {
        dateFilter.createdAt.lte = new Date(endDate);
      }
    }

    const [
      totalExpenses,
      pendingExpenses,
      approvedExpenses,
      rejectedExpenses,
      totalAmount,
      approvedAmount,
      expensesByType
    ] = await Promise.all([
      prisma.warehouseExpense.count({ where: dateFilter }),
      prisma.warehouseExpense.count({ 
        where: { ...dateFilter, status: 'PENDING' } 
      }),
      prisma.warehouseExpense.count({ 
        where: { ...dateFilter, status: 'APPROVED' } 
      }),
      prisma.warehouseExpense.count({ 
        where: { ...dateFilter, status: 'REJECTED' } 
      }),
      prisma.warehouseExpense.aggregate({
        where: dateFilter,
        _sum: { amount: true }
      }),
      prisma.warehouseExpense.aggregate({
        where: { ...dateFilter, status: 'APPROVED' },
        _sum: { amount: true }
      }),
      prisma.warehouseExpense.groupBy({
        by: ['expenseType'],
        where: { ...dateFilter, status: 'APPROVED' },
        _sum: { amount: true },
        _count: { id: true }
      })
    ]);

    res.json({
      success: true,
      data: {
        summary: {
          totalExpenses,
          pendingExpenses,
          approvedExpenses,
          rejectedExpenses,
          totalAmount: totalAmount._sum.amount || 0,
          approvedAmount: approvedAmount._sum.amount || 0
        },
        byType: expensesByType.map(item => ({
          expenseType: item.expenseType,
          count: item._count.id,
          totalAmount: item._sum.amount || 0
        }))
      }
    });
  })
);

module.exports = router;