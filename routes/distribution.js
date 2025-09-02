const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeOwnEntry } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators'); // ✅ ADDED

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// MIDDLEWARE - Distribution Module Access
// ================================

// All distribution routes require distribution module access
router.use(authorizeModule('distribution'));

// ================================
// VALIDATION RULES - UPDATED FOR CUID
// ================================

const createOrderValidation = [
  body('customerId')
    .notEmpty()
    .withMessage('Customer ID is required')
    .custom(validateCuid('customer ID')), // ✅ UPDATED
  body('locationId')
    .notEmpty()
    .withMessage('Location ID is required')
    .custom(validateCuid('location ID')), // ✅ UPDATED
  body('orderItems')
    .isArray({ min: 1 })
    .withMessage('At least one order item is required'),
  body('orderItems.*.productId')
    .notEmpty()
    .withMessage('Product ID is required')
    .custom(validateCuid('product ID')), // ✅ UPDATED
  body('orderItems.*.pallets')
    .isInt({ min: 0 })
    .withMessage('Pallets must be a non-negative integer'),
  body('orderItems.*.packs')
    .isInt({ min: 0 })
    .withMessage('Packs must be a non-negative integer'),
  body('remark')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Remark must not exceed 500 characters')
];

const updateOrderValidation = [
  body('status')
    .optional()
    .isIn(['PENDING', 'CONFIRMED', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED'])
    .withMessage('Invalid status value'),
  body('transporterCompany')
    .optional()
    .isLength({ max: 100 })
    .withMessage('Transporter company name must not exceed 100 characters'),
  body('driverNumber')
    .optional()
    .isLength({ max: 50 })
    .withMessage('Driver number must not exceed 50 characters'),
  body('remark')
    .optional()
    .isLength({ max: 500 })
    .withMessage('Remark must not exceed 500 characters')
];

const priceAdjustmentValidation = [
  body('adjustedAmount')
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Adjusted amount must be a valid decimal with up to 2 decimal places'),
  body('adjustmentType')
    .isIn(['FUEL_COST', 'LOCATION_CHANGE', 'OTHER'])
    .withMessage('Invalid adjustment type'),
  body('reason')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Reason must not exceed 200 characters'),
  body('locationFuelCost')
    .optional()
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Location fuel cost must be a valid decimal')
];

// ================================
// BUSINESS LOGIC FUNCTIONS
// ================================

const calculatePalletPrice = async (productId, pallets, packs, locationId = null) => {
  const product = await prisma.product.findUnique({
    where: { id: productId }
  });

  if (!product) {
    throw new NotFoundError('Product not found');
  }

  // Check for location-specific pricing
  let effectivePrice = product.pricePerPack;
  let fuelAdjustment = 0;

  if (locationId) {
    const locationPricing = await prisma.palletPricing.findFirst({
      where: {
        productId,
        locationId,
        isActive: true
      },
      orderBy: { effectiveDate: 'desc' }
    });

    if (locationPricing) {
      effectivePrice = locationPricing.pricePerPack;
      fuelAdjustment = locationPricing.fuelAdjustment;
    }
  }

  // Calculate total price: Pallets × Packs per Pallet × Price per Pack + Individual Packs × Price per Pack
  const palletPacks = pallets * product.packsPerPallet;
  const totalPacks = palletPacks + packs;
  const baseAmount = totalPacks * effectivePrice;
  const fuelAdjustmentAmount = baseAmount * (fuelAdjustment / 100);
  const finalAmount = baseAmount + fuelAdjustmentAmount;

  return {
    baseAmount: parseFloat(baseAmount.toFixed(2)),
    fuelAdjustmentAmount: parseFloat(fuelAdjustmentAmount.toFixed(2)),
    finalAmount: parseFloat(finalAmount.toFixed(2)),
    totalPacks,
    effectivePrice: parseFloat(effectivePrice),
    fuelAdjustment: parseFloat(fuelAdjustment)
  };
};

const validateTruckCapacity = async (orderItems) => {
  const totalPallets = orderItems.reduce((sum, item) => sum + item.pallets, 0);
  const MAX_PALLETS = 12;

  if (totalPallets > MAX_PALLETS) {
    throw new BusinessError(
      `Total pallets (${totalPallets}) exceeds maximum truck capacity (${MAX_PALLETS})`,
      'TRUCK_CAPACITY_EXCEEDED'
    );
  }

  return { totalPallets, availableSpace: MAX_PALLETS - totalPallets };
};

// ================================
// ROUTES - ORDERS
// ================================

// @route   POST /api/v1/distribution/orders
// @desc    Create new distribution order
// @access  Private (Distribution Sales Rep, Admin)
router.post('/orders', 
  authorizeModule('distribution', 'write'),
  createOrderValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { customerId, locationId, orderItems, remark } = req.body;
    const userId = req.user.id;

    // Validate truck capacity
    await validateTruckCapacity(orderItems);

    // Calculate totals
    let totalPallets = 0;
    let totalPacks = 0;
    let totalAmount = 0;
    const calculatedItems = [];

    for (const item of orderItems) {
      const calculation = await calculatePalletPrice(
        item.productId,
        item.pallets,
        item.packs,
        locationId
      );

      calculatedItems.push({
        productId: item.productId,
        pallets: item.pallets,
        packs: item.packs,
        amount: calculation.finalAmount
      });

      totalPallets += item.pallets;
      totalPacks += calculation.totalPacks;
      totalAmount += calculation.finalAmount;
    }

    // Create order with transaction
    const order = await prisma.$transaction(async (tx) => {
      const createdOrder = await tx.distributionOrder.create({
        data: {
          customerId,
          locationId,
          totalPallets,
          totalPacks,
          originalAmount: totalAmount,
          finalAmount: totalAmount,
          balance: 0,
          remark,
          createdBy: userId,
          orderItems: {
            create: calculatedItems
          }
        },
        include: {
          customer: true,
          location: true,
          orderItems: {
            include: {
              product: true
            }
          }
        }
      });

      return createdOrder;
    });

    res.status(201).json({
      success: true,
      message: 'Distribution order created successfully',
      data: { order }
    });
  })
);

// @route   GET /api/v1/distribution/orders
// @desc    Get distribution orders with filtering and pagination
// @access  Private (Distribution module access)
router.get('/orders', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    status,
    customerId,
    locationId,
    startDate,
    endDate,
    search
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  // Build where clause
  const where = {};

  // Role-based filtering - non-admins see only their own orders
  if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
    where.createdBy = req.user.id;
  }

  if (status) where.status = status;
  if (customerId) where.customerId = customerId;
  if (locationId) where.locationId = locationId;

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  if (search) {
    where.OR = [
      {
        customer: {
          name: { contains: search, mode: 'insensitive' }
        }
      },
      {
        location: {
          name: { contains: search, mode: 'insensitive' }
        }
      },
      {
        transporterCompany: { contains: search, mode: 'insensitive' }
      },
      {
        driverNumber: { contains: search, mode: 'insensitive' }
      }
    ];
  }

  const [orders, total] = await Promise.all([
    prisma.distributionOrder.findMany({
      where,
      include: {
        customer: true,
        location: true,
        orderItems: {
          include: {
            product: true
          }
        },
        createdByUser: {
          select: { username: true, role: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take
    }),
    prisma.distributionOrder.count({ where })
  ]);

  res.json({
    success: true,
    data: {
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// @route   GET /api/v1/distribution/orders/:id
// @desc    Get single distribution order
// @access  Private (Distribution module access)
router.get('/orders/:id',
  param('id').custom(validateCuid('order ID')), // ✅ UPDATED
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const where = { id };

    // Role-based access - non-admins can only see their own orders
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.createdBy = req.user.id;
    }

    const order = await prisma.distributionOrder.findFirst({
      where,
      include: {
        customer: true,
        location: true,
        orderItems: {
          include: {
            product: true
          }
        },
        priceAdjustments: {
          orderBy: { createdAt: 'desc' }
        },
        transportOrder: true,
        createdByUser: {
          select: { username: true, role: true }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    res.json({
      success: true,
      data: { order }
    });
  })
);

// @route   PUT /api/v1/distribution/orders/:id
// @desc    Update distribution order
// @access  Private (Own entries or Admin)
router.put('/orders/:id',
  param('id').custom(validateCuid('order ID')), // ✅ UPDATED
  updateOrderValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;
    const userId = req.user.id;

    // Get existing order
    const existingOrder = await prisma.distributionOrder.findUnique({
      where: { id },
      include: { orderItems: true }
    });

    if (!existingOrder) {
      throw new NotFoundError('Order not found');
    }

    // Check permissions - users can only modify their own entries
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      if (existingOrder.createdBy !== userId) {
        throw new BusinessError('You can only modify your own orders', 'ACCESS_DENIED');
      }
    } else if (req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      // Admins can only view, not modify
      throw new BusinessError('Admins have view-only access to user entries', 'ADMIN_VIEW_ONLY');
    }

    // Update order
    const updatedOrder = await prisma.distributionOrder.update({
      where: { id },
      data: updateData,
      include: {
        customer: true,
        location: true,
        orderItems: {
          include: {
            product: true
          }
        }
      }
    });

    // Log the change
    await logDataChange(
      userId,
      'distribution_order',
      id,
      'UPDATE',
      existingOrder,
      updatedOrder,
      getClientIP(req)
    );

    res.json({
      success: true,
      message: 'Order updated successfully',
      data: { order: updatedOrder }
    });
  })
);

// ================================
// ROUTES - PRICE ADJUSTMENTS
// ================================

// @route   POST /api/v1/distribution/orders/:id/price-adjustments
// @desc    Create price adjustment for order
// @access  Private (Admin only)
router.post('/orders/:id/price-adjustments',
  param('id').custom(validateCuid('order ID')), // ✅ UPDATED
  authorizeModule('distribution', 'admin'),
  priceAdjustmentValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id: orderId } = req.params;
    const { adjustedAmount, adjustmentType, reason, locationFuelCost } = req.body;

    // Get existing order
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // Create price adjustment and update order
    const result = await prisma.$transaction(async (tx) => {
      // Create price adjustment record
      const adjustment = await tx.priceAdjustment.create({
        data: {
          orderId,
          originalAmount: order.finalAmount,
          adjustedAmount: parseFloat(adjustedAmount),
          adjustmentType,
          reason,
          locationFuelCost: locationFuelCost ? parseFloat(locationFuelCost) : null
        }
      });

      // Calculate new balance
      const newBalance = parseFloat(adjustedAmount) - order.originalAmount;

      // Update order with new amounts
      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: {
          finalAmount: parseFloat(adjustedAmount),
          balance: newBalance
        },
        include: {
          customer: true,
          location: true,
          orderItems: {
            include: {
              product: true
            }
          },
          priceAdjustments: {
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      return { adjustment, order: updatedOrder };
    });

    res.status(201).json({
      success: true,
      message: 'Price adjustment created successfully',
      data: result
    });
  })
);

// ================================
// ROUTES - ANALYTICS & REPORTS
// ================================

// @route   GET /api/v1/distribution/analytics/summary
// @desc    Get distribution analytics summary
// @access  Private (Distribution module access)
router.get('/analytics/summary', asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  
  const where = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  // Role-based filtering
  if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
    where.createdBy = req.user.id;
  }

  const [
    totalOrders,
    totalRevenue,
    statusCounts,
    palletUtilization,
    topCustomers
  ] = await Promise.all([
    prisma.distributionOrder.count({ where }),
    
    prisma.distributionOrder.aggregate({
      where,
      _sum: { finalAmount: true }
    }),

    prisma.distributionOrder.groupBy({
      by: ['status'],
      where,
      _count: { status: true }
    }),

    prisma.distributionOrder.aggregate({
      where,
      _sum: { totalPallets: true },
      _avg: { totalPallets: true }
    }),

    prisma.distributionOrder.groupBy({
      by: ['customerId'],
      where,
      _count: { customerId: true },
      _sum: { finalAmount: true },
      orderBy: { _sum: { finalAmount: 'desc' } },
      take: 5
    })
  ]);

  // Get customer details for top customers
  const customerIds = topCustomers.map(c => c.customerId);
  const customers = await prisma.customer.findMany({
    where: { id: { in: customerIds } },
    select: { id: true, name: true }
  });

  const topCustomersWithDetails = topCustomers.map(tc => ({
    ...tc,
    customer: customers.find(c => c.id === tc.customerId)
  }));

  res.json({
    success: true,
    data: {
      totalOrders,
      totalRevenue: totalRevenue._sum.finalAmount || 0,
      statusDistribution: statusCounts,
      palletUtilization: {
        totalPallets: palletUtilization._sum.totalPallets || 0,
        averagePalletsPerOrder: palletUtilization._avg.totalPallets || 0
      },
      topCustomers: topCustomersWithDetails
    }
  });
}));

module.exports = router;