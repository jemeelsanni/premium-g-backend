// routes/distribution-customers.js - Distribution customer management

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { authorizeModule } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// DISTRIBUTION CUSTOMER ROUTES
// ================================

// Create distribution customer
router.post('/customers',
    authorizeModule('distribution', 'write'),
    [
        body('name').trim().notEmpty().withMessage('Customer name is required'),
        body('email').optional().isEmail().withMessage('Valid email is required'),
        body('phone').optional().trim(),
        body('address').optional().trim(),
        body('customerType').optional().isIn(['BUSINESS', 'ENTERPRISE', 'GOVERNMENT']),
        body('territory').optional().trim(),
    ],
    asyncHandler(async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            throw new ValidationError('Invalid input data', errors.array());
        }

        // Only include fields that exist in the Customer model
        const customerData = {
            name: req.body.name.trim(),
            email: req.body.email?.trim() || null,
            phone: req.body.phone?.trim() || null,
            address: req.body.address?.trim() || null,
            customerType: req.body.customerType || null,
            territory: req.body.territory?.trim() || null,
            // createdBy is NOT in the Customer model, so remove it
            // If you need to track who created it, you'll need to add createdBy to the schema
        };

        const customer = await prisma.customer.create({
            data: customerData,
            include: {
                distributionOrders: {
                    select: { id: true }
                }
            }
        });

        res.status(201).json({
            success: true,
            message: 'Distribution customer created successfully',
            data: { customer }
        });
    })
);

// Get distribution customers with filtering
router.get('/customers',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      search,
      territory,
      salesRepId,
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
        { phone: { contains: search, mode: 'insensitive' } }
      ];
    }
    
    if (territory) where.territory = territory;
    if (salesRepId) where.salesRepId = salesRepId;
    if (customerType) where.customerType = customerType;
    if (isActive !== 'all') where.isActive = isActive === 'true';

    // Role-based filtering for sales reps
    if (req.user.role === 'DISTRIBUTION_SALES_REP') {
      where.salesRepId = req.user.id;
    }

    const [customers, total] = await Promise.all([
        prisma.customer.findMany({
            where,
            include: {
            distributionOrders: {
                select: { id: true }
            }
            },
            orderBy: { name: 'asc' },
            skip,
            take
        }),
        prisma.customer.count({ where })
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

// Get single customer by ID
router.get('/customers/:id',
  authorizeModule('distribution'),
  param('id').custom(validateCuid('customer ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        distributionOrders: {
          select: {
            id: true,
            orderNumber: true,
            finalAmount: true,
            amountPaid: true,
            balance: true,
            paymentStatus: true,
            status: true,
            createdAt: true
          },
          orderBy: { createdAt: 'desc' },
          take: 10 // Get last 10 orders for summary
        }
      }
    });

    if (!customer) {
      throw new NotFoundError('Customer not found');
    }

    res.json({
      success: true,
      data: customer
    });
  })
);

// Update customer
router.put('/customers/:id',
  authorizeModule('distribution', 'write'),
  param('id').custom(validateCuid('customer ID')),
  [
    body('name').optional().trim().notEmpty().withMessage('Customer name cannot be empty'),
    body('email').optional().isEmail().withMessage('Valid email is required'),
    body('phone').optional().trim(),
    body('address').optional().trim(),
    body('customerType').optional().isIn(['BUSINESS', 'ENTERPRISE', 'GOVERNMENT']),
    body('territory').optional().trim(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;

    // Check if customer exists
    const existingCustomer = await prisma.customer.findUnique({
      where: { id }
    });

    if (!existingCustomer) {
      throw new NotFoundError('Customer not found');
    }

    // Build update data object with only provided fields
    const updateData = {};
    if (req.body.name !== undefined) updateData.name = req.body.name.trim();
    if (req.body.email !== undefined) updateData.email = req.body.email?.trim() || null;
    if (req.body.phone !== undefined) updateData.phone = req.body.phone?.trim() || null;
    if (req.body.address !== undefined) updateData.address = req.body.address?.trim() || null;
    if (req.body.customerType !== undefined) updateData.customerType = req.body.customerType;
    if (req.body.territory !== undefined) updateData.territory = req.body.territory?.trim() || null;

    const customer = await prisma.customer.update({
      where: { id },
      data: updateData
    });

    res.json({
      success: true,
      message: 'Customer updated successfully',
      data: { customer }
    });
  })
);

// Get customer order history
router.get('/customers/:id/orders',
  authorizeModule('distribution'),
  param('id').custom(validateCuid('customer ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { page = 1, limit = 10, status } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { customerId: id };
    if (status) where.status = status;

    const [orders, total, customer] = await Promise.all([
      prisma.distributionOrder.findMany({
        where,
        include: {
          location: { select: { name: true } },
          orderItems: {
            include: {
              product: { select: { name: true, productNo: true } }
            }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      prisma.distributionOrder.count({ where }),
      prisma.customer.findUnique({
        where: { id },
        select: {
          name: true,
          totalOrders: true,
          totalSpent: true,
          customerBalance: true
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
        orders,
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

module.exports = router;