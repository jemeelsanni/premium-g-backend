// routes/warehouse-expenses.js - New file for warehouse expense management

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

const createWarehouseExpenseValidation = [
  body('expenseType')
    .trim()
    .notEmpty()
    .withMessage('Expense type is required')
    .isIn([
      'UTILITIES', 'RENT', 'EQUIPMENT', 'SUPPLIES', 'MAINTENANCE', 
      'INVENTORY_PROCUREMENT', 'PACKAGING_MATERIALS', 'SECURITY', 
      'CLEANING_SERVICES', 'INSURANCE', 'OTHER'
    ])
    .withMessage('Invalid expense type'),
  body('category').trim().notEmpty().withMessage('Category is required'),
  body('amount').isFloat({ min: 0 }).withMessage('Amount must be greater than 0'),
  body('description').optional().trim(),
  body('expenseDate').isISO8601().withMessage('Valid expense date is required'),
  body('productId').optional().custom(validateCuid('product ID')),
  body('location').optional().trim(),
  body('vendorName').optional().trim(),
  body('vendorContact').optional().trim(),
  body('receiptNumber').optional().trim()
];

const updateWarehouseExpenseValidation = [
  body('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'PAID']),
  body('rejectionReason').optional().trim(),
  body('paymentMethod').optional().isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
  body('paymentReference').optional().trim()
];

// ================================
// WAREHOUSE EXPENSE ROUTES
// ================================

// @route   POST /api/v1/warehouse/expenses
// @desc    Create new warehouse expense
// @access  Private (Warehouse module access)
router.post('/expenses',
  authorizeModule('warehouse', 'write'),
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
      expenseDate,
      productId,
      location,
      vendorName,
      vendorContact,
      receiptNumber,
      receiptUrl
    } = req.body;

    const expense = await prisma.warehouseExpense.create({
      data: {
        expenseType,
        category,
        amount: parseFloat(amount),
        description,
        expenseDate: new Date(expenseDate),
        productId,
        location,
        vendorName,
        vendorContact,
        receiptNumber,
        receiptUrl,
        createdBy: req.user.id
      },
      include: {
        product: { select: { name: true, productNo: true } },
        createdByUser: { select: { id: true, username: true } }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Warehouse expense created successfully',
      data: { expense }
    });
  })
);

// @route   GET /api/v1/warehouse/expenses
// @desc    Get warehouse expenses with filtering and pagination
// @access  Private (Warehouse module access)
router.get('/expenses',
  authorizeModule('warehouse'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'PAID']),
    query('expenseType').optional(),
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
      expenseType,
      category,
      location,
      startDate,
      endDate,
      isPaid
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};

    if (status) where.status = status;
    if (expenseType) where.expenseType = expenseType;
    if (category) where.category = category;
    if (location) where.location = { contains: location, mode: 'insensitive' };
    if (isPaid !== undefined) where.isPaid = isPaid === 'true';

    if (startDate || endDate) {
      where.expenseDate = {};
      if (startDate) where.expenseDate.gte = new Date(startDate);
      if (endDate) where.expenseDate.lte = new Date(endDate);
    }

    // Role-based access control
    if (!['SUPER_ADMIN', 'WAREHOUSE_ADMIN'].includes(req.user.role)) {
      where.createdBy = req.user.id;
    }

    const [expenses, total] = await Promise.all([
      prisma.warehouseExpense.findMany({
        where,
        include: {
          product: { select: { name: true, productNo: true } },
          createdByUser: { select: { username: true } },
          approver: { select: { username: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      prisma.warehouseExpense.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        expenses,
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

// @route   GET /api/v1/warehouse/expenses/:id
// @desc    Get specific warehouse expense
// @access  Private (Warehouse module access)
router.get('/expenses/:id',
  authorizeModule('warehouse'),
  param('id').custom(validateCuid('expense ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const expense = await prisma.warehouseExpense.findUnique({
      where: { id },
      include: {
        product: { select: { name: true, productNo: true } },
        createdByUser: { select: { username: true, role: true } },
        approver: { select: { username: true, role: true } }
      }
    });

    if (!expense) {
      throw new NotFoundError('Warehouse expense not found');
    }

    // Check access permissions
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
// @desc    Update warehouse expense
// @access  Private (Warehouse Admin or creator)
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
      where: { id }
    });

    if (!expense) {
      throw new NotFoundError('Warehouse expense not found');
    }

    // Check permissions
    const canUpdate = 
      ['SUPER_ADMIN', 'WAREHOUSE_ADMIN'].includes(req.user.role) ||
      expense.createdBy === req.user.id;

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

    const updatedExpense = await prisma.warehouseExpense.update({
      where: { id },
      data: updateData,
      include: {
        product: { select: { name: true, productNo: true } },
        createdByUser: { select: { username: true } },
        approver: { select: { username: true } }
      }
    });

    res.json({
      success: true,
      message: 'Warehouse expense updated successfully',
      data: { expense: updatedExpense }
    });
  })
);

// @route   POST /api/v1/warehouse/expenses/bulk-approve
// @desc    Bulk approve warehouse expenses
// @access  Private (Warehouse Admin only)
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

    const updatedExpenses = await prisma.warehouseExpense.updateMany({
      where: {
        id: { in: expenseIds },
        status: 'PENDING'
      },
      data: updateData
    });

    res.json({
      success: true,
      message: `Successfully ${action}ed ${updatedExpenses.count} warehouse expenses`,
      data: { updatedCount: updatedExpenses.count }
    });
  })
);

// @route   DELETE /api/v1/warehouse/expenses/:id
// @desc    Delete warehouse expense (soft delete by marking as rejected)
// @access  Private (Warehouse Admin or creator)
router.delete('/expenses/:id',
  param('id').custom(validateCuid('expense ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const expense = await prisma.warehouseExpense.findUnique({
      where: { id }
    });

    if (!expense) {
      throw new NotFoundError('Warehouse expense not found');
    }

    // Check permissions
    const canDelete = 
      ['SUPER_ADMIN', 'WAREHOUSE_ADMIN'].includes(req.user.role) ||
      (expense.createdBy === req.user.id && expense.status === 'PENDING');

    if (!canDelete) {
      throw new BusinessError('Cannot delete this expense', 'INSUFFICIENT_PERMISSIONS');
    }

    // Soft delete by marking as rejected
    await prisma.warehouseExpense.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectionReason: 'Deleted by user',
        approvedBy: req.user.id,
        approvedAt: new Date()
      }
    });

    res.json({
      success: true,
      message: 'Warehouse expense deleted successfully'
    });
  })
);

// @route   GET /api/v1/warehouse/expenses/analytics/summary
// @desc    Get warehouse expense analytics
// @access  Private (Warehouse Admin)
router.get('/expenses/analytics/summary',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    const expenses = await prisma.warehouseExpense.findMany({
      where: {
        expenseDate: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
        status: { in: ['APPROVED', 'PAID'] }
      }
    });

    // Calculate expense analytics
    let totalExpenses = 0;
    const expensesByType = {};
    const expensesByCategory = {};
    const monthlyExpenses = {};

    expenses.forEach(expense => {
      const amount = parseFloat(expense.amount);
      totalExpenses += amount;

      // By type
      if (!expensesByType[expense.expenseType]) {
        expensesByType[expense.expenseType] = 0;
      }
      expensesByType[expense.expenseType] += amount;

      // By category
      if (!expensesByCategory[expense.category]) {
        expensesByCategory[expense.category] = 0;
      }
      expensesByCategory[expense.category] += amount;

      // Monthly breakdown
      const month = expense.expenseDate.toISOString().slice(0, 7); // YYYY-MM
      if (!monthlyExpenses[month]) {
        monthlyExpenses[month] = 0;
      }
      monthlyExpenses[month] += amount;
    });

    res.json({
      success: true,
      data: {
        summary: {
          totalExpenses: parseFloat(totalExpenses.toFixed(2)),
          totalRecords: expenses.length,
          averageExpense: expenses.length > 0 ? parseFloat((totalExpenses / expenses.length).toFixed(2)) : 0
        },
        breakdown: {
          byType: expensesByType,
          byCategory: expensesByCategory,
          monthly: monthlyExpenses
        },
        period: { startDate, endDate }
      }
    });
  })
);

module.exports = router;