// routes/warehouse-customers.js - Warehouse customer management

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// WAREHOUSE CUSTOMER ROUTES
// ================================

// Create warehouse customer
router.post('/customers',
  authorizeModule('warehouse', 'write'),
  [
    body('name').trim().notEmpty().withMessage('Customer name is required'),
    body('email').optional().isEmail().withMessage('Valid email is required'),
    body('phone').optional().trim(),
    body('address').optional().trim(),
    body('customerType').optional().isIn(['INDIVIDUAL', 'BUSINESS', 'RETAILER']),
    body('businessName').optional().trim(),
    body('creditLimit').optional().isFloat({ min: 0 }),
    body('preferredPaymentMethod').optional().isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY'])
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const customerData = {
      ...req.body,
      createdBy: req.user.id
    };

    const customer = await prisma.warehouseCustomer.create({
      data: customerData,
      include: {
        createdByUser: { select: { id: true, username: true } }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Warehouse customer created successfully',
      data: { customer }
    });
  })
);

// Get warehouse customers
router.get('/customers',
  authorizeModule('warehouse'),
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      search,
      customerType,
      isActive = 'true'
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};
    
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { businessName: { contains: search, mode: 'insensitive' } }
      ];
    }
    
    if (customerType) where.customerType = customerType;
    if (isActive !== 'all') where.isActive = isActive === 'true';

    const [customers, total] = await Promise.all([
      prisma.warehouseCustomer.findMany({
        where,
        include: {
          _count: { select: { warehouseSales: true } }
        },
        orderBy: { name: 'asc' },
        skip,
        take
      }),
      prisma.warehouseCustomer.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        customers,
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

// Get warehouse customer purchase history
router.get('/customers/:id/purchases',
  authorizeModule('warehouse'),
  param('id').custom(validateCuid('customer ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { page = 1, limit = 10, startDate, endDate } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { warehouseCustomerId: id };
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [sales, total, customer] = await Promise.all([
      prisma.warehouseSale.findMany({
        where,
        include: {
          product: { select: { name: true, productNo: true } },
          salesOfficerUser: { select: { username: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      prisma.warehouseSale.count({ where }),
      prisma.warehouseCustomer.findUnique({
        where: { id },
        select: { 
          name: true, 
          totalPurchases: true, 
          totalSpent: true, 
          averageOrderValue: true,
          lastPurchaseDate: true
        }
      })
    ]);

    if (!customer) {
      throw new NotFoundError('Customer not found');
    }

    res.json({
      success: true,
      data: {
        customer,
        purchases: sales,
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

// Update warehouse customer
router.put('/customers/:id',
  authorizeModule('warehouse', 'write'),
  param('id').custom(validateCuid('customer ID')),
  [
    body('name').optional().trim(),
    body('email').optional().isEmail(),
    body('phone').optional().trim(),
    body('address').optional().trim(),
    body('customerType').optional().isIn(['INDIVIDUAL', 'BUSINESS', 'RETAILER']),
    body('businessName').optional().trim(),
    body('creditLimit').optional().isFloat({ min: 0 }),
    body('preferredPaymentMethod').optional().isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
    body('isActive').optional().isBoolean()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;

    const customer = await prisma.warehouseCustomer.update({
      where: { id },
      data: updateData,
      include: {
        createdByUser: { select: { username: true } }
      }
    });

    res.json({
      success: true,
      message: 'Customer updated successfully',
      data: { customer }
    });
  })
);

module.exports = router;