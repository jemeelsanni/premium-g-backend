const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators'); // ✅ ADDED
const distributionCustomersRouter = require('./distribution-customers');
const distributionPaymentService = require('../services/distributionPaymentService');


const router = express.Router();
const prisma = new PrismaClient();

// ================================
// MIDDLEWARE - Distribution Module Access
// ================================

// All distribution routes require distribution module access
router.use(authorizeModule('distribution'));
router.use('/', distributionCustomersRouter);

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
    .withMessage('Adjusted amount must be a valid decimal'),
  body('adjustmentType')
    .isIn(['RITE_FOODS_PRICE_CHANGE'])
    .withMessage('Invalid adjustment type. Only Rite Foods price changes allowed'),
  body('reason')
    .notEmpty()
    .withMessage('Reason for Rite Foods price change is required')
    .isLength({ max: 500 })
    .withMessage('Reason must not exceed 500 characters'),
  body('riteFoodsInvoiceReference')
    .optional()
    .trim()
    .isString()  // ✅ Add validator before withMessage
    .withMessage('Rite Foods invoice reference must be a string')
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

  // Check for location-specific pricing (base price only, no adjustments)
  let effectivePrice = product.pricePerPack;

  if (locationId) {
    const locationPricing = await prisma.palletPricing.findFirst({
      where: { productId, locationId, isActive: true },
      orderBy: { effectiveDate: 'desc' }
    });

    if (locationPricing) {
      effectivePrice = locationPricing.pricePerPack;
    }
  }

  // ✅ SIMPLE: Just quantity × Rite Foods price
  const palletPacks = pallets * product.packsPerPallet;
  const totalPacks = palletPacks + packs;
  const finalAmount = totalPacks * effectivePrice;  // No adjustments!

  return {
    finalAmount: parseFloat(finalAmount.toFixed(2)),
    totalPacks,
    effectivePrice: parseFloat(effectivePrice)
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

// Helper function to validate order before creation
async function validateOrderCreation(customerId, orderItems, totalAmount) {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  // Check customer
  const customer = await prisma.customer.findUnique({
    where: { id: customerId }
  });

  if (!customer) {
    throw new NotFoundError('Customer not found');
  }

  if (!customer.isActive) {
    throw new ValidationError('Customer account is inactive');
  }

  // Check credit limit
  if (customer.creditLimit) {
    const currentSpent = parseFloat(customer.totalSpent || 0);
    const creditLimit = parseFloat(customer.creditLimit);
    const availableCredit = creditLimit - currentSpent;

    if (totalAmount > availableCredit) {
      return {
        valid: false,
        error: `Order exceeds available credit. Available: ₦${availableCredit.toFixed(2)}, Requested: ₦${totalAmount.toFixed(2)}`,
        requiresApproval: true,
        customer: {
          name: customer.name,
          creditLimit,
          currentSpent,
          availableCredit
        }
      };
    }
  }

  // Validate products
  for (const item of orderItems) {
    const product = await prisma.product.findUnique({
      where: { id: item.productId }
    });

    if (!product) {
      throw new NotFoundError(`Product ${item.productId} not found`);
    }

    if (!product.isActive) {
      throw new ValidationError(`Product ${product.name} is inactive`);
    }

    if (product.module !== 'DISTRIBUTION') {
      throw new ValidationError(`Product ${product.name} is not available for distribution`);
    }
  }

  return {
    valid: true,
    customer
  };
}

// @route   POST /api/v1/distribution/orders/validate
// @desc    Validate order before creation (pre-check)
// @access  Private (Distribution write access)
router.post('/orders/validate',
  authorizeModule('distribution', 'write'),
  [
    body('customerId').custom(validateCuid('customer ID')),
    body('locationId').custom(validateCuid('location ID')),
    body('orderItems').isArray({ min: 1 }),
    body('orderItems.*.productId').custom(validateCuid('product ID')),
    body('orderItems.*.pallets').isInt({ min: 0 }),
    body('orderItems.*.packs').isInt({ min: 0 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { customerId, locationId, orderItems } = req.body;

    // Calculate total
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
        totalPacks: calculation.totalPacks,
        amount: calculation.finalAmount
      });

      totalAmount += calculation.finalAmount;
    }

    // Validate
    const validation = await validateOrderCreation(
      customerId,
      orderItems,
      totalAmount
    );

    res.json({
      success: validation.valid,
      data: {
        validation,
        orderSummary: {
          totalAmount: parseFloat(totalAmount.toFixed(2)),
          items: calculatedItems
        }
      }
    });
  })
);

// ================================
// ROUTES - ORDERS
// ================================

// @route   POST /api/v1/distribution/orders
// @desc    Create new distribution order
// @access  Private (Distribution Sales Rep, Admin)
router.post('/orders',
  authorizeModule('distribution', 'write'),
  [
    body('customerId').custom(validateCuid('customer ID')),
    body('locationId').custom(validateCuid('location ID')),
    body('orderItems').isArray({ min: 1 }).withMessage('Order must have at least one item'),
    body('orderItems.*.productId').custom(validateCuid('product ID')),
    body('orderItems.*.pallets').isInt({ min: 0 }).withMessage('Pallets must be 0 or greater'),
    body('orderItems.*.packs').isInt({ min: 0 }).withMessage('Packs must be 0 or greater'),
    body('remark').optional().trim(),
    // NEW: Optional initial payment info
    body('initialPayment').optional().isObject(),
    body('initialPayment.amount').optional().isFloat({ min: 0 }),
    body('initialPayment.method').optional().isIn(['BANK_TRANSFER', 'CASH', 'CHECK', 'WHATSAPP_TRANSFER', 'POS', 'MOBILE_MONEY']),
    body('initialPayment.reference').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { customerId, locationId, orderItems, remark, initialPayment } = req.body;
    const userId = req.user.id;

    // Verify customer exists
    const customer = await prisma.customer.findUnique({
      where: { id: customerId }
    });

    if (!customer) {
      throw new NotFoundError('Distribution customer not found');
    }

    // Calculate order totals
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

    // Check credit limit if customer has one
    if (customer.creditLimit) {
      const potentialSpent = parseFloat(customer.totalSpent || 0) + totalAmount;
      
      if (potentialSpent > parseFloat(customer.creditLimit)) {
        throw new ValidationError(
          `Order exceeds customer credit limit. Available credit: ₦${(parseFloat(customer.creditLimit) - parseFloat(customer.totalSpent || 0)).toFixed(2)}`
        );
      }
    }

    // Create order with payment tracking
    const order = await prisma.$transaction(async (tx) => {
      const createdOrder = await tx.distributionOrder.create({
        data: {
          customerId,
          locationId,
          totalPallets,
          totalPacks,
          originalAmount: totalAmount,
          finalAmount: totalAmount,
          balance: totalAmount, // Initially full amount is balance
          remark,
          createdBy: userId,
          status: 'PENDING',
          paymentStatus: 'PENDING',
          orderItems: {
            create: calculatedItems
          }
        },
        include: {
          customer: true,
          location: true,
          orderItems: {
            include: { product: true }
          }
        }
      });

      // If initial payment provided, record it
      if (initialPayment && initialPayment.amount > 0) {
        await distributionPaymentService.recordCustomerPayment({
          orderId: createdOrder.id,
          amount: initialPayment.amount,
          paymentMethod: initialPayment.method,
          reference: initialPayment.reference,
          paidBy: customer.name,
          receivedBy: req.user.username,
          notes: 'Initial payment with order creation',
          userId
        });
      }

      // Update current week's performance
      const currentDate = new Date();
      const weekNumber = Math.ceil(currentDate.getDate() / 7);
      
      const target = await tx.distributionTarget.findFirst({
        where: {
          year: currentDate.getFullYear(),
          month: currentDate.getMonth() + 1
        }
      });

      if (target) {
        const weekPerf = await tx.weeklyPerformance.findUnique({
          where: {
            targetId_weekNumber: {
              targetId: target.id,
              weekNumber
            }
          }
        });

        if (weekPerf) {
          const newActual = parseInt(weekPerf.actualPacks) + totalPacks;
          const achievement = weekPerf.targetPacks > 0 
            ? (newActual / weekPerf.targetPacks) * 100 
            : 0;

          await tx.weeklyPerformance.update({
            where: {
              targetId_weekNumber: {
                targetId: target.id,
                weekNumber
              }
            },
            data: {
              actualPacks: newActual,
              percentageAchieved: parseFloat(achievement.toFixed(2))
            }
          });
        }
      }

      // Create distribution analytics entry
      await tx.distributionAnalytics.create({
        data: {
          analysisType: 'ORDER',
          totalRevenue: totalAmount,
          costOfGoodsSold: await calculateDistributionCOGS(calculatedItems),
          grossProfit: totalAmount - await calculateDistributionCOGS(calculatedItems),
          netProfit: totalAmount - await calculateDistributionCOGS(calculatedItems),
          profitMargin: totalAmount > 0 ?
            ((totalAmount - await calculateDistributionCOGS(calculatedItems)) / totalAmount) * 100 : 0,
          totalOrders: 1,
          totalPacks,
          totalPallets
        }
      });

      return createdOrder;
    });

    // Fetch updated order with payment info
    const finalOrder = await prisma.distributionOrder.findUnique({
      where: { id: order.id },
      include: {
        customer: true,
        location: true,
        orderItems: {
          include: { product: true }
        },
        paymentHistory: true
      }
    });

    res.status(201).json({
      success: true,
      message: 'Distribution order created successfully',
      data: { order: finalOrder }
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
// @desc    Get single distribution order with full details
// @access  Private (Distribution module access)
router.get('/orders/:id',
  param('id').custom(validateCuid('order ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const where = { id };

    // Role-based access
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
        paymentHistory: {
          orderBy: { createdAt: 'desc' }
        },
        paymentConfirmer: {
          select: { username: true, role: true }
        },
        deliveryReviewer: {
          select: { username: true, role: true }
        },
        transportOrder: true,
        createdByUser: {
          select: { username: true, role: true }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Distribution order not found');
    }

    // Format response with all workflow stages
    const formattedOrder = {
      ...order,
      workflow: {
        stage1_orderCreation: {
          createdBy: order.createdByUser.username,
          createdAt: order.createdAt,
          status: 'COMPLETED'
        },
        stage2_payment: {
          status: order.paymentStatus,
          totalAmount: parseFloat(order.finalAmount),
          amountPaid: parseFloat(order.amountPaid),
          balance: parseFloat(order.balance),
          confirmedBy: order.paymentConfirmer?.username,
          confirmedAt: order.paymentConfirmedAt,
          payments: order.paymentHistory.filter(p => p.paymentType === 'TO_COMPANY')
        },
        stage3_riteFoods: {
          status: order.riteFoodsStatus,
          paidToRiteFoods: order.paidToRiteFoods,
          amountPaid: order.amountPaidToRiteFoods ? parseFloat(order.amountPaidToRiteFoods) : null,
          paymentDate: order.paymentDateToRiteFoods,
          orderNumber: order.riteFoodsOrderNumber,
          invoiceNumber: order.riteFoodsInvoiceNumber,
          orderRaised: order.orderRaisedByRFL,
          raisedAt: order.orderRaisedAt,
          loadedDate: order.riteFoodsLoadedDate
        },
        stage4_transport: {
          transporter: order.transporterCompany,
          driver: order.driverNumber,
          truck: order.truckNumber,
          status: order.deliveryStatus
        },
        stage5_delivery: {
          status: order.deliveryStatus,
          ordered: {
            pallets: order.totalPallets,
            packs: order.totalPacks
          },
          delivered: {
            pallets: order.deliveredPallets || 0,
            packs: order.deliveredPacks || 0
          },
          deliveredAt: order.deliveredAt,
          deliveredBy: order.deliveredBy,
          reviewedBy: order.deliveryReviewer?.username,
          reviewedAt: order.deliveryReviewedAt,
          notes: order.deliveryNotes,
          issues: {
            partial: order.partialDeliveryReason,
            failed: order.nonDeliveryReason
          }
        }
      }
    };

    res.json({
      success: true,
      data: { order: formattedOrder }
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

    // Validate order status
    if (order.paymentStatus !== 'CONFIRMED') {
      throw new BusinessError(
        'Price adjustments only allowed after payment is confirmed',
        'INVALID_ORDER_STATE'
      );
    }

    // Create price adjustment and update order
    const result = await prisma.$transaction(async (tx) => {
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

      // Calculate new balance correctly
      const amountPaid = parseFloat(order.amountPaid);
      const newFinalAmount = parseFloat(adjustedAmount);
      const newBalance = newFinalAmount - amountPaid;

      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: {
          finalAmount: newFinalAmount,
          balance: newBalance,
          paymentStatus: newBalance === 0 ? 'CONFIRMED' : 
                        newBalance > 0 ? 'PARTIAL' : 'OVERPAID'
        },
        include: {
          customer: true,
          location: true,
          orderItems: { include: { product: true } },
          priceAdjustments: { orderBy: { createdAt: 'desc' } }
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

// @route   PUT /api/v1/distribution/orders/:id/status
// @desc    Update order status (comprehensive status management)
// @access  Private (Distribution write access)
router.put('/orders/:id/status',
  authorizeModule('distribution', 'write'),
  [
    param('id').custom(validateCuid('order ID')),
    body('status').isIn([
      'PENDING',
      'PAYMENT_CONFIRMED',
      'SENT_TO_RITE_FOODS',
      'PROCESSING_BY_RFL',
      'LOADED',
      'IN_TRANSIT',
      'DELIVERED',
      'PARTIALLY_DELIVERED',
      'CANCELLED',
      'RETURNED'
    ]),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { status, notes } = req.body;

    const order = await prisma.distributionOrder.findUnique({
      where: { id },
      include: {
        customer: true,
        location: true
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // Validate status transitions
    const validTransitions = {
      'PENDING': ['PAYMENT_CONFIRMED', 'CANCELLED'],
      'PAYMENT_CONFIRMED': ['SENT_TO_RITE_FOODS', 'CANCELLED'],
      'SENT_TO_RITE_FOODS': ['PROCESSING_BY_RFL', 'CANCELLED'],
      'PROCESSING_BY_RFL': ['LOADED', 'CANCELLED'],
      'LOADED': ['IN_TRANSIT', 'CANCELLED'],
      'IN_TRANSIT': ['DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED'],
      'DELIVERED': [],
      'PARTIALLY_DELIVERED': ['DELIVERED', 'CANCELLED'],
      'CANCELLED': [],
      'RETURNED': []
    };

    if (!validTransitions[order.status].includes(status) && order.status !== status) {
      throw new ValidationError(
        `Cannot transition from ${order.status} to ${status}`
      );
    }

    const updatedOrder = await prisma.$transaction(async (tx) => {
      const updated = await tx.distributionOrder.update({
        where: { id },
        data: {
          status,
          updatedAt: new Date()
        },
        include: {
          customer: true,
          location: true,
          orderItems: {
            include: { product: true }
          }
        }
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId: req.user.id,
          action: 'UPDATE',
          entity: 'DistributionOrder',
          entityId: id,
          oldValues: { status: order.status },
          newValues: { status, notes }
        }
      });

      return updated;
    });

    res.json({
      success: true,
      message: `Order status updated to ${status}`,
      data: { order: updatedOrder }
    });
  })
);

// @route   GET /api/v1/distribution/products
// @desc    Get products available for distribution (Rite Foods only)
// @access  Private (Distribution module access)
router.get('/products', asyncHandler(async (req, res) => {
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      module: 'DISTRIBUTION'
    },
    orderBy: { name: 'asc' }
  });

  res.json({
    success: true,
    data: { products }
  });
}));


// @route   GET /api/v1/distribution/locations
// @desc    Get delivery locations for distribution
// @access  Private (Distribution module access)
router.get('/locations', 
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const locations = await prisma.location.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        address: true,
        isActive: true
      }
    });

    res.json({
      success: true,
      data: { locations }
    });
  })
);

// @route   POST /api/v1/distribution/orders/bulk/confirm-payments
// @desc    Bulk confirm payments (for accountant)
// @access  Private (Admin only)
router.post('/orders/bulk/confirm-payments',
  authorizeModule('distribution', 'admin'),
  [
    body('orderIds').isArray({ min: 1 }).withMessage('Must provide at least one order ID'),
    body('orderIds.*').custom(validateCuid('order ID')),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { orderIds, notes } = req.body;

    // Check if user is authorized (accountant/admin)
    if (!['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'CASHIER'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Only accountants and admins can confirm payments'
      });
    }

    const results = {
      successful: [],
      failed: []
    };

    for (const orderId of orderIds) {
      try {
        const order = await distributionPaymentService.confirmPayment(
          orderId,
          req.user.id,
          notes
        );
        results.successful.push({
          orderId,
          orderNumber: order.id,
          customer: order.customer.name
        });
      } catch (error) {
        results.failed.push({
          orderId,
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `Confirmed ${results.successful.length} payments, ${results.failed.length} failed`,
      data: results
    });
  })
);

// @route   GET /api/v1/distribution/dashboard/ready-for-transport
// @desc    Get orders that are loaded at Rite Foods and ready for transport assignment
// @access  Private (Distribution admin)
router.get('/dashboard/ready-for-transport',
  authorizeModule('distribution', 'admin'),
  asyncHandler(async (req, res) => {
    const readyOrders = await prisma.distributionOrder.findMany({
      where: {
        riteFoodsStatus: 'LOADED',
        transporterCompany: null,
        paymentStatus: 'CONFIRMED',
        balance: 0
      },
      include: {
        customer: { select: { name: true, phone: true } },
        location: { select: { name: true, address: true } }
      },
      orderBy: { riteFoodsLoadedDate: 'asc' }
    });

    const formatted = readyOrders.map(order => ({
      id: order.id,
      customer: order.customer.name,
      customerPhone: order.customer.phone,
      location: order.location.name,
      locationAddress: order.location.address,
      totalPallets: order.totalPallets,
      totalPacks: order.totalPacks,
      amount: parseFloat(order.finalAmount),
      loadedDate: order.riteFoodsLoadedDate,
      daysWaiting: order.riteFoodsLoadedDate 
        ? Math.floor((new Date() - new Date(order.riteFoodsLoadedDate)) / (1000 * 60 * 60 * 24))
        : 0
    }));

    res.json({
      success: true,
      message: `${formatted.length} orders ready for transport assignment`,
      data: {
        orders: formatted,
        count: formatted.length
      }
    });
  })
);

// @route   POST /api/v1/distribution/orders/bulk/send-to-ritefoods
// @desc    Bulk send orders to Rite Foods
// @access  Private (Admin only)
router.post('/orders/bulk/send-to-ritefoods',
  authorizeModule('distribution', 'admin'),
  [
    body('orders').isArray({ min: 1 }).withMessage('Must provide at least one order'),
    body('orders.*.orderId').custom(validateCuid('order ID')),
    body('orders.*.amount').isFloat({ min: 0.01 }),
    body('paymentMethod').isIn(['BANK_TRANSFER', 'CHECK']),
    body('batchReference').trim().notEmpty().withMessage('Batch reference is required')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { orders, paymentMethod, batchReference } = req.body;

    const results = {
      successful: [],
      failed: []
    };

    for (const orderInfo of orders) {
      try {
        const result = await distributionPaymentService.recordPaymentToRiteFoods({
          orderId: orderInfo.orderId,
          amount: orderInfo.amount,
          paymentMethod,
          reference: `${batchReference}-${orderInfo.orderId.slice(-6)}`,
          riteFoodsOrderNumber: orderInfo.riteFoodsOrderNumber,
          riteFoodsInvoiceNumber: orderInfo.riteFoodsInvoiceNumber,
          userId: req.user.id
        });
        
        results.successful.push({
          orderId: orderInfo.orderId,
          amount: orderInfo.amount
        });
      } catch (error) {
        results.failed.push({
          orderId: orderInfo.orderId,
          error: error.message
        });
      }
    }

    const totalAmount = results.successful.reduce((sum, r) => sum + r.amount, 0);

    res.json({
      success: true,
      message: `Sent ${results.successful.length} orders to Rite Foods. Total: ₦${totalAmount.toFixed(2)}`,
      data: {
        ...results,
        summary: {
          totalOrders: results.successful.length,
          totalAmount: totalAmount,
          batchReference
        }
      }
    });
  })
);

// ================================
// ROUTES - ANALYTICS & REPORTS
// ================================

// @route   GET /api/v1/distribution/analytics/summary
// @desc    Get distribution analytics summary
// @access  Private (Distribution module access)
router.get('/analytics/summary', 
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const { startDate, endDate, period = 'monthly' } = req.query;
    
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    // Get pure distribution analytics
    const orders = await prisma.distributionOrder.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
        status: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
      },
      include: {
        orderItems: { include: { product: true } }
      }
    });

    // Calculate standalone distribution metrics
    let totalRevenue = 0;
    let totalCOGS = 0;
    let totalPacks = 0;
    let totalPallets = 0;

    for (const order of orders) {
      totalRevenue += parseFloat(order.finalAmount);
      totalPacks += order.totalPacks;
      totalPallets += order.totalPallets;
      
      // Calculate COGS for this order
      for (const item of order.orderItems) {
        const itemPacks = (item.pallets * item.product.packsPerPallet) + item.packs;
        totalCOGS += itemPacks * parseFloat(item.product.costPerPack || 0);
      }
    }

    const grossProfit = totalRevenue - totalCOGS;
    const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalCOGS: parseFloat(totalCOGS.toFixed(2)),
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          totalOrders: orders.length,
          totalPacks,
          totalPallets
        },
        period: { startDate, endDate }
      }
    });
  })
);

// @route   GET /api/v1/distribution/dashboard/workflow-summary
// @desc    Get summary of orders at each workflow stage
// @access  Private (Distribution access)
router.get('/dashboard/workflow-summary',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const [
      pendingPayment,
      paymentConfirmed,
      sentToRiteFoods,
      inTransit,
      delivered,
      issues
    ] = await Promise.all([
      // Stage 1: Pending Payment
      prisma.distributionOrder.count({
        where: { paymentStatus: { in: ['PENDING', 'PARTIAL'] } }
      }),
      
      // Stage 2: Payment Confirmed, ready for Rite Foods
      prisma.distributionOrder.count({
        where: {
          paymentStatus: 'CONFIRMED',
          paidToRiteFoods: false
        }
      }),
      
      // Stage 3: Sent to Rite Foods
      prisma.distributionOrder.count({
        where: {
          paidToRiteFoods: true,
          riteFoodsStatus: { in: ['PAYMENT_SENT', 'ORDER_RAISED', 'PROCESSING', 'LOADED'] }
        }
      }),
      
      // Stage 4: In Transit
      prisma.distributionOrder.count({
        where: { deliveryStatus: 'IN_TRANSIT' }
      }),
      
      // Stage 5: Delivered
      prisma.distributionOrder.count({
        where: { deliveryStatus: 'FULLY_DELIVERED' }
      }),
      
      // Issues: Partial/Failed
      prisma.distributionOrder.count({
        where: { deliveryStatus: { in: ['PARTIALLY_DELIVERED', 'FAILED'] } }
      })
    ]);

    // Get recent activity
    const recentOrders = await prisma.distributionOrder.findMany({
      take: 10,
      orderBy: { updatedAt: 'desc' },
      include: {
        customer: { select: { name: true } },
        location: { select: { name: true } }
      }
    });

    res.json({
      success: true,
      data: {
        workflowStages: {
          stage1_pendingPayment: pendingPayment,
          stage2_paymentConfirmed: paymentConfirmed,
          stage3_sentToRiteFoods: sentToRiteFoods,
          stage4_inTransit: inTransit,
          stage5_delivered: delivered,
          issues: issues
        },
        recentActivity: recentOrders.map(order => ({
          id: order.id,
          customer: order.customer.name,
          location: order.location.name,
          amount: parseFloat(order.finalAmount),
          status: order.status,
          paymentStatus: order.paymentStatus,
          deliveryStatus: order.deliveryStatus,
          updatedAt: order.updatedAt
        }))
      }
    });
  })
);

// @route   GET /api/v1/distribution/reports/payment-reconciliation
// @desc    Payment reconciliation report
// @access  Private (Admin)
router.get('/reports/payment-reconciliation',
  authorizeModule('distribution', 'admin'),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    const orders = await prisma.distributionOrder.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined
      },
      include: {
        customer: { select: { name: true } },
        paymentHistory: true
      }
    });

    const summary = {
      totalOrders: orders.length,
      totalOrderValue: 0,
      totalReceived: 0,
      totalSentToRiteFoods: 0,
      outstandingBalance: 0,
      byPaymentStatus: {
        PENDING: { count: 0, amount: 0 },
        PARTIAL: { count: 0, amount: 0 },
        CONFIRMED: { count: 0, amount: 0 },
        OVERPAID: { count: 0, amount: 0 }
      }
    };

    const detailedOrders = orders.map(order => {
      const orderValue = parseFloat(order.finalAmount);
      const received = parseFloat(order.amountPaid);
      const sentToRiteFoods = parseFloat(order.amountPaidToRiteFoods || 0);
      const balance = parseFloat(order.balance);

      summary.totalOrderValue += orderValue;
      summary.totalReceived += received;
      summary.totalSentToRiteFoods += sentToRiteFoods;
      summary.outstandingBalance += balance;

      summary.byPaymentStatus[order.paymentStatus].count += 1;
      summary.byPaymentStatus[order.paymentStatus].amount += balance;

      return {
        orderId: order.id,
        customer: order.customer.name,
        orderValue,
        received,
        balance,
        sentToRiteFoods,
        paymentStatus: order.paymentStatus,
        riteFoodsStatus: order.riteFoodsStatus,
        createdAt: order.createdAt,
        payments: order.paymentHistory.map(p => ({
          amount: parseFloat(p.amount),
          type: p.paymentType,
          method: p.paymentMethod,
          date: p.createdAt
        }))
      };
    });

    res.json({
      success: true,
      data: {
        summary: {
          ...summary,
          totalOrderValue: parseFloat(summary.totalOrderValue.toFixed(2)),
          totalReceived: parseFloat(summary.totalReceived.toFixed(2)),
          totalSentToRiteFoods: parseFloat(summary.totalSentToRiteFoods.toFixed(2)),
          outstandingBalance: parseFloat(summary.outstandingBalance.toFixed(2)),
          collectionRate: summary.totalOrderValue > 0 
            ? `${((summary.totalReceived / summary.totalOrderValue) * 100).toFixed(2)}%`
            : '0%'
        },
        orders: detailedOrders
      }
    });
  })
);

// @route   GET /api/v1/distribution/reports/delivery-performance
// @desc    Delivery performance report
// @access  Private (Admin)
router.get('/reports/delivery-performance',
  authorizeModule('distribution', 'admin'),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    const orders = await prisma.distributionOrder.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
        deliveryStatus: { in: ['FULLY_DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED'] }
      },
      include: {
        customer: { select: { name: true } },
        location: { select: { name: true } }
      }
    });

    const summary = {
      totalDeliveries: orders.length,
      fullyDelivered: 0,
      partiallyDelivered: 0,
      failed: 0,
      totalOrderedPacks: 0,
      totalDeliveredPacks: 0,
      byLocation: {}
    };

    orders.forEach(order => {
      summary.totalOrderedPacks += order.totalPacks;
      summary.totalDeliveredPacks += (order.deliveredPacks || 0);

      if (order.deliveryStatus === 'FULLY_DELIVERED') summary.fullyDelivered += 1;
      if (order.deliveryStatus === 'PARTIALLY_DELIVERED') summary.partiallyDelivered += 1;
      if (order.deliveryStatus === 'FAILED') summary.failed += 1;

      const locationName = order.location.name;
      if (!summary.byLocation[locationName]) {
        summary.byLocation[locationName] = {
          total: 0,
          delivered: 0,
          partial: 0,
          failed: 0
        };
      }
      summary.byLocation[locationName].total += 1;
      if (order.deliveryStatus === 'FULLY_DELIVERED') {
        summary.byLocation[locationName].delivered += 1;
      } else if (order.deliveryStatus === 'PARTIALLY_DELIVERED') {
        summary.byLocation[locationName].partial += 1;
      } else {
        summary.byLocation[locationName].failed += 1;
      }
    });

    const deliveryRate = summary.totalOrderedPacks > 0
      ? (summary.totalDeliveredPacks / summary.totalOrderedPacks) * 100
      : 0;

    const successRate = summary.totalDeliveries > 0
      ? (summary.fullyDelivered / summary.totalDeliveries) * 100
      : 0;

    res.json({
      success: true,
      data: {
        summary: {
          ...summary,
          deliveryRate: `${deliveryRate.toFixed(2)}%`,
          successRate: `${successRate.toFixed(2)}%`
        },
        locationPerformance: Object.entries(summary.byLocation).map(([location, stats]) => ({
          location,
          ...stats,
          successRate: stats.total > 0 
            ? `${((stats.delivered / stats.total) * 100).toFixed(2)}%`
            : '0%'
        }))
      }
    });
  })
);

// @route   GET /api/v1/distribution/reports/rite-foods-orders
// @desc    Rite Foods orders tracking report
// @access  Private (Admin)
router.get('/reports/rite-foods-orders',
  authorizeModule('distribution', 'admin'),
  asyncHandler(async (req, res) => {
    const { status, startDate, endDate } = req.query;

    const where = {
      paidToRiteFoods: true
    };

    if (status) {
      where.riteFoodsStatus = status;
    }

    if (startDate || endDate) {
      where.paymentDateToRiteFoods = {};
      if (startDate) where.paymentDateToRiteFoods.gte = new Date(startDate);
      if (endDate) where.paymentDateToRiteFoods.lte = new Date(endDate);
    }

    const orders = await prisma.distributionOrder.findMany({
      where,
      include: {
        customer: { select: { name: true } },
        location: { select: { name: true } }
      },
      orderBy: { paymentDateToRiteFoods: 'desc' }
    });

    const summary = {
      totalOrders: orders.length,
      totalAmount: 0,
      byStatus: {
        PAYMENT_SENT: 0,
        ORDER_RAISED: 0,
        PROCESSING: 0,
        LOADED: 0,
        DISPATCHED: 0
      }
    };

    const detailedOrders = orders.map(order => {
      const amount = parseFloat(order.amountPaidToRiteFoods || 0);
      summary.totalAmount += amount;
      summary.byStatus[order.riteFoodsStatus] += 1;

      return {
        orderId: order.id,
        customer: order.customer.name,
        location: order.location.name,
        amountPaid: amount,
        paymentDate: order.paymentDateToRiteFoods,
        riteFoodsOrderNumber: order.riteFoodsOrderNumber,
        riteFoodsInvoiceNumber: order.riteFoodsInvoiceNumber,
        status: order.riteFoodsStatus,
        orderRaisedAt: order.orderRaisedAt,
        loadedDate: order.riteFoodsLoadedDate
      };
    });

    res.json({
      success: true,
      data: {
        summary: {
          ...summary,
          totalAmount: parseFloat(summary.totalAmount.toFixed(2))
        },
        orders: detailedOrders
      }
    });
  })
);

// @route   GET /api/v1/distribution/locations/available
// @desc    Get all available locations with pricing and route info
// @access  Private (Distribution module access)
router.get('/locations/available',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const locations = await prisma.location.findMany({
      where: { isActive: true },
      include: {
        haulageRates: {
          where: { isActive: true },
          orderBy: { effectiveDate: 'desc' },
          take: 1
        },
        salaryRates: {
          where: { isActive: true },
          orderBy: { effectiveDate: 'desc' },
          take: 1
        },
        _count: {
          select: {
            distributionOrders: true
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    const formattedLocations = locations.map(location => ({
      id: location.id,
      name: location.name,
      address: location.address,
      fuelAdjustment: parseFloat(location.fuelAdjustment || 0),
      deliveryNotes: location.deliveryNotes,
      
      // Haulage rates info (for transport)
      haulageRates: location.haulageRates[0] ? {
        distance: parseFloat(location.haulageRates[0].distance),
        rate15Ton: parseFloat(location.haulageRates[0].rate15Ton),
        rate20Ton: parseFloat(location.haulageRates[0].rate20Ton),
        rate30Ton: parseFloat(location.haulageRates[0].rate30Ton),
        locationCode: location.haulageRates[0].locationCode
      } : null,
      
      // Salary rates info (for transport)
      salaryRates: location.salaryRates[0] ? {
        tripAllowance: parseFloat(location.salaryRates[0].tripAllowance),
        driverWages: parseFloat(location.salaryRates[0].driverWages),
        motorBoyWages: parseFloat(location.salaryRates[0].motorBoyWages),
        totalWages: parseFloat(location.salaryRates[0].totalWages)
      } : null,
      
      // Usage statistics
      statistics: {
        totalOrders: location._count.distributionOrders
      }
    }));

    res.json({
      success: true,
      data: {
        locations: formattedLocations,
        count: formattedLocations.length
      }
    });
  })
);

// @route   GET /api/v1/distribution/locations/:id/pricing
// @desc    Get location-specific pricing for products
// @access  Private (Distribution module access)
router.get('/locations/:id/pricing',
  authorizeModule('distribution'),
  [
    param('id').custom(validateCuid('location ID'))
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;

    const location = await prisma.location.findUnique({
      where: { id },
      include: {
        palletPricing: {
          where: { isActive: true },
          include: {
            product: true
          }
        }
      }
    });

    if (!location) {
      throw new NotFoundError('Location not found');
    }

    // Get all products with their pricing
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        module: 'DISTRIBUTION'
      }
    });

    const productPricing = products.map(product => {
      const customPricing = location.palletPricing.find(
        p => p.productId === product.id
      );

      const pricePerPack = customPricing 
        ? parseFloat(customPricing.pricePerPack)
        : parseFloat(product.pricePerPack);

      // ✅ No fuel adjustment - just the base price
      return {
        productId: product.id,
        productName: product.name,
        packsPerPallet: product.packsPerPallet,
        pricePerPack: pricePerPack,
        pricePerPallet: parseFloat((pricePerPack * product.packsPerPallet).toFixed(2))
      };
    });

    res.json({
      success: true,
      data: {
        location: {
          id: location.id,
          name: location.name,
          fuelAdjustment: parseFloat(location.fuelAdjustment || 0)
        },
        products: productPricing
      }
    });
  })
);

// Helper function to calculate distribution COGS
const calculateDistributionCOGS = async (orderItems) => {
  let totalCOGS = 0;
  
  for (const item of orderItems) {
    const product = await prisma.product.findUnique({
      where: { id: item.productId }
    });
    
    if (product && product.costPerPack) {
      const itemPacks = (item.pallets * product.packsPerPallet) + item.packs;
      totalCOGS += itemPacks * parseFloat(product.costPerPack);
    }
  }
  
  return totalCOGS;
};




module.exports = router;