const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators'); // ✅ ADDED
const { generateDistributionOrderNumber } = require('../utils/orderNumberGenerator');

const { Parser } = require('json2csv');
const PDFDocument = require('pdfkit-table');

const distributionPaymentRouter = require('./distributionPayment');
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
router.use('/', distributionPaymentRouter); 

// ================================
// VALIDATION RULES - UPDATED FOR CUID
// ================================

const createOrderValidation = [
  body('customerId')
    .notEmpty()
    .withMessage('Customer ID is required')
    .custom(validateCuid('customer ID')),
  body('locationId')
    .optional()
    .custom(validateCuid('location ID')),
  body('deliveryLocation')  // ✅ Accept as text
    .optional()
    .trim()
    .isLength({ min: 3, max: 500 })
    .withMessage('Delivery location must be between 3 and 500 characters'),
  body('orderItems')
    .isArray({ min: 1 })
    .withMessage('At least one order item is required'),
  body('orderItems.*.productId')
    .notEmpty()
    .withMessage('Product ID is required')
    .custom(validateCuid('product ID')),
  body('orderItems.*.pallets')
    .isInt({ min: 0 })
    .withMessage('Pallets must be a non-negative integer'),
  body('orderItems.*.packs')
    .isInt({ min: 0 })
    .withMessage('Packs must be a non-negative integer'),
  body('orderItems.*.amount')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Amount must be a positive number'),
  body('remark')
    .optional()
    .trim()
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
    .isIn(['SUPPLIER_PRICE_CHANGE', 'CUSTOMER_NEGOTIATION', 'ERROR_CORRECTION', 'OTHER', 'RITE_FOODS_PRICE_CHANGE'])
    .withMessage('Invalid adjustment type. Must be SUPPLIER_PRICE_CHANGE, CUSTOMER_NEGOTIATION, ERROR_CORRECTION, or OTHER'),
  body('reason')
    .notEmpty()
    .withMessage('Reason for price adjustment is required')
    .isLength({ max: 500 })
    .withMessage('Reason must not exceed 500 characters'),
  body('riteFoodsInvoiceReference')
    .optional()
    .trim()
    .isString()
    .withMessage('Supplier invoice reference must be a string'),
  body('supplierInvoiceReference')
    .optional()
    .trim()
    .isString()
    .withMessage('Supplier invoice reference must be a string')
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
  createOrderValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { customerId, supplierCompanyId, locationId, deliveryLocation, orderItems, amountPaid, remark } = req.body;

    const orderNumber = await generateDistributionOrderNumber();


    console.log('📦 Received order data:', { customerId, supplierCompanyId, locationId, deliveryLocation, orderItems });

    // Validate that at least deliveryLocation is provided
    if (!deliveryLocation) {
      throw new ValidationError('Delivery location is required');
    }

    // Find or create location based on deliveryLocation text
    let finalLocationId = locationId;
    
    if (!finalLocationId && deliveryLocation) {
      // Try to find existing location by name
      let location = await prisma.location.findFirst({
        where: {
          name: {
            equals: deliveryLocation.trim(),
            mode: 'insensitive'
          }
        }
      });

      // If not found, create a new location
      if (!location) {
        location = await prisma.location.create({
          data: {
            name: deliveryLocation.trim(),
            address: deliveryLocation.trim(),
            isActive: true
          }
        });
        console.log('✅ Created new location:', location.name);
      } else {
        console.log('✅ Found existing location:', location.name);
      }

      finalLocationId = location.id;
    }

    // Verify customer exists
    const customer = await prisma.customer.findUnique({
      where: { id: customerId }
    });

    if (!customer) {
      throw new NotFoundError('Customer not found');
    }

    // Verify supplier company exists if provided
    if (supplierCompanyId) {
      const supplier = await prisma.supplierCompany.findUnique({
        where: { id: supplierCompanyId }
      });

      if (!supplier) {
        throw new NotFoundError('Supplier company not found');
      }

      if (!supplier.isActive) {
        throw new BusinessError('Supplier company is not active');
      }
    }

    // Calculate totals and validate products
    let totalPallets = 0;
    let totalPacks = 0;
    let totalAmount = 0;
    const validatedItems = [];

    for (const item of orderItems) {
      // Verify product exists
      const product = await prisma.product.findUnique({
        where: { id: item.productId }
      });

      if (!product) {
        throw new NotFoundError(`Product not found: ${item.productId}`);
      }

      if (!product.isActive) {
        throw new BusinessError(`Product is not active: ${product.name}`);
      }

      const pallets = parseInt(item.pallets) || 0;
      const packs = parseInt(item.packs) || 0;
      const amount = parseFloat(item.amount) || 0;

      totalPallets += pallets;
      totalPacks += packs;
      totalAmount += amount;

      validatedItems.push({
        productId: item.productId,
        pallets,
        packs,
        amount
      });
    }

    // Calculate payment details
    const initialPayment = parseFloat(amountPaid) || 0;
    const orderBalance = totalAmount - initialPayment;

    // Determine payment status based on amount paid
    let paymentStatus = 'PENDING';
    if (initialPayment >= totalAmount) {
      paymentStatus = initialPayment > totalAmount ? 'OVERPAID' : 'CONFIRMED';
    } else if (initialPayment > 0) {
      paymentStatus = 'PARTIAL';
    }

    // Create order in transaction
    const order = await prisma.$transaction(async (tx) => {
      // Create the order with deliveryLocation field
      const createdOrder = await tx.distributionOrder.create({
        data: {
          orderNumber,
          customerId,
          supplierCompanyId: supplierCompanyId || null,
          locationId: finalLocationId,
          deliveryLocation: deliveryLocation.trim(),  // ✅ Store the text field
          totalPallets,
          totalPacks,
          originalAmount: totalAmount,
          finalAmount: totalAmount,
          balance: orderBalance,
          amountPaid: initialPayment,
          status: 'PENDING',
          paymentStatus: paymentStatus,
          createdBy: req.user.id,
          remark: remark?.trim() || null,
          orderItems: {
            create: validatedItems
          }
        },
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              address: true
            }
          },
          location: {
            select: {
              id: true,
              name: true,
              address: true
            }
          },
          orderItems: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  module: true
                }
              }
            }
          }
        }
      });

      // Update weekly performance if applicable
      const currentDate = new Date();
      const weekNumber = Math.ceil(currentDate.getDate() / 7);

      try {
        const target = await tx.distributionTarget.findFirst({
          where: {
            year: currentDate.getFullYear(),
            month: currentDate.getMonth() + 1
          },
          include: {
            weeklyPerformances: {
              where: { weekNumber }
            }
          }
        });

        if (target && target.weeklyPerformances.length > 0) {
          const weekPerf = target.weeklyPerformances[0];
          const newActual = (weekPerf.actualPacks || 0) + totalPacks;
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
      } catch (error) {
        console.log('⚠️ Weekly performance update skipped:', error.message);
      }

      // Create initial payment history record if customer paid something
      if (initialPayment > 0) {
        const customerData = await tx.customer.findUnique({
          where: { id: customerId },
          select: { name: true }
        });

        await tx.paymentHistory.create({
          data: {
            orderId: createdOrder.id,
            amount: initialPayment,
            paymentType: 'TO_COMPANY',
            paymentMethod: 'CASH', // Default, can be updated later if needed
            paidBy: customerData?.name || 'Customer',
            receivedBy: req.user.username || 'System',
            notes: 'Initial payment during order creation'
          }
        });
      }

      // Update customer balance
      // Customer balance logic: Positive = customer owes us, Negative = we owe customer (credit)
      // When order is created: add the balance to customer's total balance
      await tx.customer.update({
        where: { id: customerId },
        data: {
          customerBalance: {
            increment: orderBalance
          },
          totalOrders: {
            increment: 1
          },
          totalSpent: {
            increment: totalAmount
          },
          lastOrderDate: new Date()
        }
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId: req.user.id,
          action: 'CREATE',
          entity: 'DistributionOrder',
          entityId: createdOrder.id,
          newValues: {
            customerId,
            locationId: finalLocationId,
            deliveryLocation: deliveryLocation.trim(),
            totalAmount,
            amountPaid: initialPayment,
            balance: orderBalance,
            paymentStatus
          }
        }
      });

      return createdOrder;
    });

    console.log('✅ Order created successfully:', order.id);

    res.status(201).json({
      success: true,
      message: 'Order created successfully',
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
    paymentStatus,
    supplierStatus,
    deliveryStatus,
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
  if (paymentStatus) where.paymentStatus = paymentStatus;
  if (supplierStatus) where.supplierStatus = supplierStatus;
  if (deliveryStatus) where.deliveryStatus = deliveryStatus;
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
        supplierCompany: true,
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
        supplierCompany: true,
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
  param('id').custom(validateCuid('order ID')),
  authorizeModule('distribution', 'admin'),
  priceAdjustmentValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id: orderId } = req.params;
    const { adjustedAmount, adjustmentType, reason, riteFoodsInvoiceReference, itemChanges } = req.body;

    // Get existing order
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        location: true,
        orderItems: { include: { product: true } },
        priceAdjustments: { 
          orderBy: { createdAt: 'desc' },
          include: { adjuster: true }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // ✅ VALIDATION 1: Check if payment is confirmed
    if (order.paymentStatus !== 'CONFIRMED') {
      throw new BusinessError(
        'Price adjustments only allowed after payment is confirmed',
        'INVALID_ORDER_STATE'
      );
    }

    // ✨ VALIDATION 2: Check if order has been raised by supplier
    if (order.orderRaisedBySupplier === true) {
      throw new BusinessError(
        `Price adjustment not permitted. This order was raised by supplier on ${
          order.orderRaisedAt
            ? new Date(order.orderRaisedAt).toLocaleDateString()
            : 'a previous date'
        }. Once an order is raised, the pricing is locked and cannot be modified.`,
        'ORDER_ALREADY_RAISED'
      );
    }

    // ✨ VALIDATION 3: Check if order has been loaded or dispatched
    const lockedStatuses = ['LOADED', 'DISPATCHED'];
    if (lockedStatuses.includes(order.supplierStatus)) {
      throw new BusinessError(
        `Price adjustment not permitted. Order has been ${order.supplierStatus.toLowerCase()}. ` +
        `Price adjustments are only allowed before the order is loaded.`,
        'ORDER_STATUS_LOCKED'
      );
    }

    // Create price adjustment and update order
    const result = await prisma.$transaction(async (tx) => {
      // Store item changes details in reason field (JSON format) if provided
      let detailedReason = reason;
      if (itemChanges && Array.isArray(itemChanges) && itemChanges.length > 0) {
        const itemChangeSummary = itemChanges.map(change =>
          `${change.productName}: ₦${change.oldPricePerPack} → ₦${change.newPricePerPack} per pack (${change.packs} packs)`
        ).join('; ');
        detailedReason = `${reason}\n\nItem Changes:\n${itemChangeSummary}`;
      }

      const adjustment = await tx.priceAdjustment.create({
        data: {
          orderId,
          originalAmount: order.finalAmount,
          adjustedAmount: parseFloat(adjustedAmount),
          adjustmentType,
          reason: detailedReason,
          riteFoodsInvoiceReference: riteFoodsInvoiceReference || null,
          adjustedBy: req.user.id
        }
      });

      // Update individual order item amounts if itemChanges provided
      if (itemChanges && Array.isArray(itemChanges) && itemChanges.length > 0) {
        for (const change of itemChanges) {
          await tx.distributionOrderItem.update({
            where: { id: change.itemId },
            data: {
              amount: parseFloat(change.newAmount)
            }
          });
        }
      }

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
          priceAdjustments: { 
            orderBy: { createdAt: 'desc' },
            include: { adjuster: true }
          }
        }
      });

      // Log the adjustment in audit trail
      await tx.auditLog.create({
        data: {
          userId: req.user.id,
          action: 'PRICE_ADJUSTMENT',
          entity: 'DistributionOrder',
          entityId: orderId,
          oldValues: {
            originalAmount: order.finalAmount
          },
          newValues: {
            adjustedAmount: newFinalAmount,
            reason,
            adjustmentType
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
      'SENT_TO_SUPPLIER',
      'PROCESSING_BY_SUPPLIER',
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
      'PAYMENT_CONFIRMED': ['SENT_TO_SUPPLIER', 'CANCELLED'],
      'SENT_TO_SUPPLIER': ['PROCESSING_BY_SUPPLIER', 'CANCELLED'],
      'PROCESSING_BY_SUPPLIER': ['LOADED', 'CANCELLED'],
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
    const { startDate, endDate } = req.query;
    
    // Default to current month if no dates provided
    const now = new Date();
    const defaultStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const defaultEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    
    const dateFilter = {};
    if (startDate) {
      dateFilter.gte = new Date(startDate);
    } else {
      dateFilter.gte = defaultStart;
    }
    
    if (endDate) {
      dateFilter.lte = new Date(endDate);
    } else {
      dateFilter.lte = defaultEnd;
    }

    // Get all orders for the period
    const allOrders = await prisma.distributionOrder.findMany({
      where: {
        createdAt: dateFilter
      },
      include: {
        customer: { 
          select: { 
            id: true, 
            name: true 
          } 
        },
        location: { 
          select: { 
            name: true 
          } 
        },
        orderItems: { 
          include: { 
            product: true 
          } 
        }
      }
    });

    // Calculate metrics from ALL orders
    let totalRevenue = 0;
    let totalCOGS = 0;
    let totalPacks = 0;
    let totalPallets = 0;
    const customerIds = new Set();
    const customerStats = {};
    const locationStats = {};

    for (const order of allOrders) {
      // Use finalAmount which is the correct field in the schema
      // Convert Decimal to number explicitly
      const orderRevenue = typeof order.finalAmount === 'object' && order.finalAmount !== null
        ? parseFloat(order.finalAmount.toString())
        : parseFloat(order.finalAmount);
      
      totalRevenue += orderRevenue;
      
      // Add the totalPacks from the order (already calculated and stored)
      totalPacks += order.totalPacks;
      totalPallets += order.totalPallets;
      
      // Track unique customers
      if (order.customer?.id) {
        customerIds.add(order.customer.id);
      }
      
      // Customer analytics
      const customerName = order.customer?.name || 'Unknown';
      if (!customerStats[customerName]) {
        customerStats[customerName] = { orders: 0, revenue: 0, packs: 0 };
      }
      customerStats[customerName].orders += 1;
      customerStats[customerName].revenue += orderRevenue;
      customerStats[customerName].packs += order.totalPacks;

      // Location analytics
      const locationName = order.location?.name || 'Unknown';
      if (!locationStats[locationName]) {
        locationStats[locationName] = { orders: 0, revenue: 0, packs: 0 };
      }
      locationStats[locationName].orders += 1;
      locationStats[locationName].revenue += orderRevenue;
      locationStats[locationName].packs += order.totalPacks;
      
      // Calculate COGS for profit analysis
      for (const item of order.orderItems) {
        const itemPacks = (item.pallets * item.product.packsPerPallet) + item.packs;
        totalCOGS += itemPacks * parseFloat(item.product.costPerPack || 0);
      }
    }

    const grossProfit = totalRevenue - totalCOGS;
    const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const averageOrderValue = allOrders.length > 0 ? totalRevenue / allOrders.length : 0;

    // Get top customers and locations
    const topCustomers = Object.entries(customerStats)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const topLocations = Object.entries(locationStats)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    // Get recent orders with proper formatting and Decimal conversion
    // Get recent orders with proper formatting and Decimal conversion
const recentOrders = allOrders
  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  .slice(0, 3)
  .map(order => {
    // Handle Prisma Decimal type for finalAmount
    let amount = 0;
    if (order.finalAmount) {
      if (typeof order.finalAmount === 'object' && order.finalAmount !== null) {
        // Prisma Decimal object - convert to string then parse
        amount = parseFloat(order.finalAmount.toString());
      } else {
        amount = parseFloat(order.finalAmount);
      }
    }
    
    // Ensure valid date
    let dateStr;
    try {
      const dateObj = order.createdAt instanceof Date ? order.createdAt : new Date(order.createdAt);
      dateStr = dateObj.toISOString();
    } catch (e) {
      dateStr = new Date().toISOString();
    }
    
    return {
      id: order.id,
      orderNumber: order.id.slice(-8).toUpperCase(),
      customer: order.customer?.name || 'Unknown',
      finalAmount: isNaN(amount) ? 0 : amount, // ✅ Changed from 'amount' to 'finalAmount'
      status: order.status || 'PENDING',
      createdAt: dateStr
    };
  });

    console.log('Dashboard Analytics DEBUG:', {
      totalOrders: allOrders.length,
      totalRevenue,
      totalPacks,
      activeCustomers: customerIds.size,
      sampleOrder: recentOrders[0],
      sampleOrderRaw: allOrders[0] ? {
        id: allOrders[0].id,
        finalAmount: allOrders[0].finalAmount,
        finalAmountType: typeof allOrders[0].finalAmount,
        createdAt: allOrders[0].createdAt,
        createdAtType: typeof allOrders[0].createdAt
      } : null
    });

    res.json({
      success: true,
      data: {
        // Dashboard summary stats (top-level for easy access)
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        totalOrders: allOrders.length,
        totalPacks,
        activeCustomers: customerIds.size,
        recentOrders,
        
        // Additional detailed analytics
        summary: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalCOGS: parseFloat(totalCOGS.toFixed(2)),
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          totalOrders: allOrders.length,
          totalPacks,
          totalPallets,
          averageOrderValue: parseFloat(averageOrderValue.toFixed(2)),
          activeCustomers: customerIds.size
        },
        topCustomers,
        topLocations,
        period: { 
          startDate: dateFilter.gte, 
          endDate: dateFilter.lte 
        }
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



// @route   GET /api/v1/distribution/orders/export/csv
// @desc    Export orders to CSV in tabular format
// @access  Private (Distribution module access)
router.get('/orders/export/csv',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const { 
      status, 
      paymentStatus, 
      riteFoodsStatus, 
      deliveryStatus,
      startDate, 
      endDate 
    } = req.query;

    const where = {};
    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (riteFoodsStatus) where.riteFoodsStatus = riteFoodsStatus;
    if (deliveryStatus) where.deliveryStatus = deliveryStatus;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const orders = await prisma.distributionOrder.findMany({
      where,
      include: {
        customer: true,
        location: true,
        orderItems: {
          include: { product: true }
        },
        createdByUser: {
          select: { username: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Define CSV fields in order
    const fields = [
      { label: 'Order Number', value: 'orderNumber' },
      { label: 'Customer Name', value: 'customerName' },
      { label: 'Customer Phone', value: 'customerPhone' },
      { label: 'Customer Email', value: 'customerEmail' },
      { label: 'Customer Type', value: 'customerType' },
      { label: 'Territory', value: 'territory' },
      { label: 'Location', value: 'location' },
      { label: 'Delivery Address', value: 'deliveryLocation' },
      { label: 'Total Pallets', value: 'totalPallets' },
      { label: 'Total Packs', value: 'totalPacks' },
      { label: 'Original Amount (₦)', value: 'originalAmount' },
      { label: 'Final Amount (₦)', value: 'finalAmount' },
      { label: 'Amount Paid (₦)', value: 'amountPaid' },
      { label: 'Balance (₦)', value: 'balance' },
      { label: 'Payment Status', value: 'paymentStatus' },
      { label: 'Payment Method', value: 'paymentMethod' },
      { label: 'Payment Reference', value: 'paymentReference' },
      { label: 'Paid to Rite Foods', value: 'paidToRiteFoods' },
      { label: 'Rite Foods Order Number', value: 'riteFoodsOrderNumber' },
      { label: 'Rite Foods Invoice Number', value: 'riteFoodsInvoiceNumber' },
      { label: 'Rite Foods Status', value: 'riteFoodsStatus' },
      { label: 'Delivery Status', value: 'deliveryStatus' },
      { label: 'Transporter Company', value: 'transporterCompany' },
      { label: 'Driver Number', value: 'driverNumber' },
      { label: 'Truck Number', value: 'truckNumber' },
      { label: 'Delivered Pallets', value: 'deliveredPallets' },
      { label: 'Delivered Packs', value: 'deliveredPacks' },
      { label: 'Order Status', value: 'orderStatus' },
      { label: 'Created By', value: 'createdBy' },
      { label: 'Created Date', value: 'createdAt' },
      { label: 'Remark', value: 'remark' },
      { label: 'Delivery Notes', value: 'deliveryNotes' }
    ];

    const csvData = orders.map(order => ({
      orderNumber: order.orderNumber || `ORD-${order.id.slice(-8)}`,
      customerName: order.customer?.name || 'N/A',
      customerPhone: order.customer?.phone || 'N/A',
      customerEmail: order.customer?.email || 'N/A',
      customerType: order.customer?.customerType || 'N/A',
      territory: order.customer?.territory || 'N/A',
      location: order.location?.name || 'N/A',
      deliveryLocation: order.deliveryLocation || 'N/A',
      totalPallets: order.totalPallets,
      totalPacks: order.totalPacks,
      originalAmount: parseFloat(order.originalAmount).toFixed(2),
      finalAmount: parseFloat(order.finalAmount).toFixed(2),
      amountPaid: parseFloat(order.amountPaid).toFixed(2),
      balance: parseFloat(order.balance).toFixed(2),
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod || 'N/A',
      paymentReference: order.paymentReference || 'N/A',
      paidToRiteFoods: order.paidToRiteFoods ? 'Yes' : 'No',
      riteFoodsOrderNumber: order.riteFoodsOrderNumber || 'N/A',
      riteFoodsInvoiceNumber: order.riteFoodsInvoiceNumber || 'N/A',
      riteFoodsStatus: order.riteFoodsStatus,
      deliveryStatus: order.deliveryStatus,
      transporterCompany: order.transporterCompany || 'N/A',
      driverNumber: order.driverNumber || 'N/A',
      truckNumber: order.truckNumber || 'N/A',
      deliveredPallets: order.deliveredPallets || 0,
      deliveredPacks: order.deliveredPacks || 0,
      orderStatus: order.status,
      createdBy: order.createdByUser?.username || 'N/A',
      createdAt: new Date(order.createdAt).toLocaleString(),
      remark: order.remark || 'N/A',
      deliveryNotes: order.deliveryNotes || 'N/A'
    }));

    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=distribution-orders-${new Date().toISOString().split('T')[0]}.csv`);
    res.send('\uFEFF' + csv); // Add BOM for Excel compatibility
  })
);

// @route   GET /api/v1/distribution/orders/export/pdf
// @desc    Export orders to PDF with flexible options
// @access  Private (Distribution module access)
router.get('/orders/export/pdf',
  authorizeModule('distribution'),
  [
    query('startDate').optional().isISO8601().withMessage('Invalid start date'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit must be between 1 and 1000'),
    query('all').optional().isBoolean().withMessage('All must be boolean'),
    // Existing filters
    query('status').optional(),
    query('paymentStatus').optional(),
    query('riteFoodsStatus').optional(),
    query('deliveryStatus').optional()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { 
      status, 
      paymentStatus, 
      riteFoodsStatus, 
      deliveryStatus,
      startDate, 
      endDate,
      limit,
      all
    } = req.query;

    // Build where clause
    const where = {};
    if (status) where.status = status;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (riteFoodsStatus) where.riteFoodsStatus = riteFoodsStatus;
    if (deliveryStatus) where.deliveryStatus = deliveryStatus;

    // Date range handling
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    // Query options
    const queryOptions = {
      where,
      include: {
        customer: {
          select: { name: true, phone: true, territory: true }
        },
        location: {
          select: { name: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    };

    // Apply limit if specified (and no date range)
    if (limit && !startDate && !endDate && all !== 'true') {
      queryOptions.take = parseInt(limit);
    } else if (!startDate && !endDate && all !== 'true') {
      // Default: last 100 orders
      queryOptions.take = 100;
    }

    const orders = await prisma.distributionOrder.findMany(queryOptions);

    const doc = new PDFDocument({ 
      margin: 30, 
      size: 'A4', 
      layout: 'landscape'
    });
    
    // Generate filename based on export type
    let filename = 'distribution-orders';
    if (startDate && endDate) {
      filename = `orders-${startDate}-to-${endDate}.pdf`;
    } else if (limit) {
      filename = `orders-last-${limit}.pdf`;
    } else if (all === 'true') {
      filename = `orders-all-${new Date().toISOString().split('T')[0]}.pdf`;
    } else {
      filename = `distribution-orders-${new Date().toISOString().split('T')[0]}.pdf`;
    }
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    doc.pipe(res);

    // Header with better styling
    doc.fontSize(20)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('DISTRIBUTION ORDERS REPORT', { align: 'center' });
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#666')
       .text(`Generated on ${new Date().toLocaleString('en-NG', { 
         dateStyle: 'full', 
         timeStyle: 'short' 
       })}`, { align: 'center' });
    
    // Add export criteria info
    doc.fontSize(9)
       .fillColor('#666');
    
    if (startDate && endDate) {
      doc.text(`Period: ${startDate} to ${endDate}`, { align: 'center' });
    } else if (limit) {
      doc.text(`Last ${limit} Orders`, { align: 'center' });
    } else if (all === 'true') {
      doc.text(`All Orders (${orders.length} total)`, { align: 'center' });
    } else {
      doc.text(`Last 100 Orders`, { align: 'center' });
    }
    
    doc.moveDown(1);

    // Summary Stats Box
    const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.finalAmount), 0);
    const totalPaid = orders.reduce((sum, o) => sum + parseFloat(o.amountPaid), 0);
    const totalBalance = orders.reduce((sum, o) => sum + parseFloat(o.balance), 0);
    const totalPacks = orders.reduce((sum, o) => sum + o.totalPacks, 0);
    const totalPallets = orders.reduce((sum, o) => sum + o.totalPallets, 0);
    
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .fillColor('#000')
       .text('SUMMARY', 40, doc.y, { underline: true });
    
    doc.moveDown(0.3);
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');
    
    const summaryY = doc.y;
    const col1X = 40;
    const col2X = 200;
    const col3X = 380;
    const col4X = 560;
    
    // Column 1
    doc.text('Total Orders:', col1X, summaryY);
    doc.font('Helvetica-Bold').text(orders.length.toString(), col1X, summaryY + 15);
    
    // Column 2
    doc.font('Helvetica').text('Total Revenue:', col2X, summaryY);
    doc.font('Helvetica-Bold').text(`NGN ${totalRevenue.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, col2X, summaryY + 15);
    
    // Column 3
    doc.font('Helvetica').text('Total Pallets:', col3X, summaryY);
    doc.font('Helvetica-Bold').text(totalPallets.toLocaleString(), col3X, summaryY + 15);
    
    // Column 4
    doc.font('Helvetica').text('Total Packs:', col4X, summaryY);
    doc.font('Helvetica-Bold').text(totalPacks.toLocaleString(), col4X, summaryY + 15);
    
    doc.moveDown(3);
    
    // Draw separator line
    doc.moveTo(30, doc.y)
       .lineTo(doc.page.width - 30, doc.y)
       .strokeColor('#ddd')
       .stroke();
    
    doc.moveDown(0.5);

    // Main Orders Table with all headers
    const tableData = {
      headers: [
        'Order #',
        'Customer',
        'Location',
        'Pallets',
        'Packs',
        'Amount (NGN)',
        'Paid (NGN)',
        'Balance (NGN)',
        'Payment Status',
        'RF Status',
        'Delivery',
        'Status'
      ],
      rows: orders.map(order => [
        order.orderNumber || `ORD-${order.id.slice(-8)}`,
        order.customer?.name || 'N/A',
        order.location?.name || 'N/A',
        order.totalPallets.toString(),
        order.totalPacks.toLocaleString(),
        parseFloat(order.finalAmount).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        parseFloat(order.amountPaid).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        parseFloat(order.balance).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        order.paymentStatus || 'N/A',
        order.riteFoodsStatus || 'N/A',
        order.deliveryStatus || 'N/A',
        order.status
      ])
    };

    // Calculate column sizes to fill full width
    const columnSizes = [60, 90, 70, 45, 50, 75, 75, 75, 75, 75, 70, 70];

    doc.table(tableData, {
      prepareHeader: () => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
      },
      prepareRow: (row, indexColumn, indexRow, rectRow, rectCell) => {
        doc.font('Helvetica').fontSize(8).fillColor('#000');
      },
      padding: 6,
      columnSpacing: 4,
      columnsSize: columnSizes,
      x: 30,
      width: doc.page.width - 60,
      headerRows: 1,
      divider: {
        header: { disabled: false, width: 1.5, opacity: 1, color: '#000' },
        horizontal: { disabled: false, width: 0.5, opacity: 1, color: '#000' }
      }
    });

    doc.moveDown(1);

    // Footer with totals
    doc.fontSize(10)
       .font('Helvetica-Bold')
       .fillColor('#000')
       .text('TOTALS', 40, doc.y);
    
    doc.moveDown(0.3);
    
    doc.fontSize(9)
       .font('Helvetica')
       .fillColor('#000');
    
    const footerY = doc.y;
    doc.text(`Revenue: NGN ${totalRevenue.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 40, footerY);
    doc.text(`Paid: NGN ${totalPaid.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 250, footerY);
    doc.text(`Balance: NGN ${totalBalance.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 460, footerY);

    // Page footer
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#666')
       .text(
         `Premium G Enterprise - Distribution Report | ${orders.length} Orders`,
         30,
         doc.page.height - 40,
         { align: 'center', width: doc.page.width - 60 }
       );

    doc.end();
  })
);


// @route   GET /api/v1/distribution/orders/:id/export/pdf
// @desc    Export single order as beautifully formatted PDF
// @access  Private (Distribution module access)
router.get('/orders/:id/export/pdf',
  param('id').custom(validateCuid('order ID')),
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;

    const order = await prisma.distributionOrder.findUnique({
      where: { id },
      include: {
        customer: true,
        location: true,
        orderItems: {
          include: { product: true }
        },
        priceAdjustments: {
          orderBy: { createdAt: 'desc' },
          include: { adjuster: true }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    const doc = new PDFDocument({ 
      margin: 50, 
      size: 'A4'
    });
    
    const filename = `order-${order.orderNumber || order.id.slice(-8)}-${new Date().toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    doc.pipe(res);

    // ===== HEADER SECTION =====
    doc.rect(0, 0, doc.page.width, 120)
       .fill('#1e40af');

    doc.fontSize(28)
       .font('Helvetica-Bold')
       .fillColor('#ffffff')
       .text('PREMIUM G ENTERPRISE', 50, 30);
    
    doc.fontSize(11)
       .font('Helvetica')
       .fillColor('#e0e7ff')
       .text('Distribution Order Invoice', 50, 65);
    
    // Order number and date on right
    doc.fontSize(10)
       .fillColor('#ffffff')
       .text(`Order #: ${order.orderNumber || `ORD-${order.id.slice(-8)}`}`, 400, 40, { align: 'right' });
    
    doc.fontSize(9)
       .fillColor('#e0e7ff')
       .text(`Date: ${new Date(order.createdAt).toLocaleDateString('en-NG', { 
         year: 'numeric', 
         month: 'long', 
         day: 'numeric' 
       })}`, 400, 60, { align: 'right' });

    // Status badge
    const statusColor =
      order.status === 'DELIVERED' ? '#10b981' :
      order.status === 'PROCESSING' || order.status === 'PROCESSING_BY_SUPPLIER' ? '#3b82f6' :
      order.status === 'PENDING' ? '#f59e0b' : '#6b7280';
    
    doc.rect(400, 80, 145, 25)
       .fill(statusColor);
    
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .fillColor('#ffffff')
       .text(order.status, 400, 88, { width: 145, align: 'center' });

    doc.fillColor('#000000'); // Reset to black

    // ===== CUSTOMER & DELIVERY INFO =====
    let yPos = 150;

    // Customer box
    doc.fontSize(12)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('CUSTOMER INFORMATION', 50, yPos);
    
    doc.rect(50, yPos + 20, 230, 90)
       .strokeColor('#e5e7eb')
       .stroke();
    
    yPos += 30;
    doc.fontSize(10)
       .font('Helvetica-Bold')
       .fillColor('#000')
       .text(order.customer?.name || 'N/A', 60, yPos);
    
    yPos += 20;
    doc.fontSize(9)
       .font('Helvetica')
       .fillColor('#4b5563');
    
    if (order.customer?.phone) {
      doc.text(`Phone: ${order.customer.phone}`, 60, yPos);
      yPos += 15;
    }
    
    if (order.customer?.email) {
      doc.text(`Email: ${order.customer.email}`, 60, yPos);
      yPos += 15;
    }
    
    if (order.customer?.territory) {
      doc.text(`Territory: ${order.customer.territory}`, 60, yPos);
    }

    // Delivery box
    yPos = 150;
    doc.fontSize(12)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('DELIVERY INFORMATION', 315, yPos);
    
    doc.rect(315, yPos + 20, 230, 90)
       .strokeColor('#e5e7eb')
       .stroke();
    
    yPos += 30;
    doc.fontSize(10)
       .font('Helvetica-Bold')
       .fillColor('#000')
       .text(order.location?.name || 'N/A', 325, yPos);
    
    yPos += 20;
    doc.fontSize(9)
       .font('Helvetica')
       .fillColor('#4b5563')
       .text(`Address: ${order.deliveryLocation || 'N/A'}`, 325, yPos, { width: 210 });

    // ===== ORDER ITEMS TABLE =====
    yPos = 280;
    
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('ORDER ITEMS', 50, yPos);
    
    yPos += 30;

    // Table header
    doc.rect(50, yPos, 495, 30)
       .fill('#f3f4f6');
    
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .fillColor('#374151');
    
    doc.text('PRODUCT', 60, yPos + 10);
    doc.text('PALLETS', 280, yPos + 10);
    doc.text('PACKS', 350, yPos + 10);
    doc.text('AMOUNT (NGN)', 430, yPos + 10, { align: 'right' });

    yPos += 30;
    doc.strokeColor('#e5e7eb').moveTo(50, yPos).lineTo(545, yPos).stroke();

    // Table rows
    doc.font('Helvetica').fillColor('#000');
    
    order.orderItems.forEach((item, index) => {
      yPos += 5;
      
      if (yPos > 700) {
        doc.addPage();
        yPos = 50;
      }

      const rowBg = index % 2 === 0 ? '#ffffff' : '#f9fafb';
      doc.rect(50, yPos, 495, 35).fill(rowBg);

      doc.fontSize(9)
         .fillColor('#000')
         .text(item.product?.name || 'N/A', 60, yPos + 12, { width: 200 });
      
      doc.text(item.pallets.toString(), 280, yPos + 12);
      doc.text(item.packs.toLocaleString(), 350, yPos + 12);
      doc.text(parseFloat(item.amount).toLocaleString('en-NG', { 
        minimumFractionDigits: 2 
      }), 430, yPos + 12, { align: 'right' });

      yPos += 35;
      doc.strokeColor('#e5e7eb').moveTo(50, yPos).lineTo(545, yPos).stroke();
    });

    // ===== PRICE ADJUSTMENTS (if any) =====
    if (order.priceAdjustments && order.priceAdjustments.length > 0) {
      yPos += 20;
      
      doc.fontSize(12)
         .font('Helvetica-Bold')
         .fillColor('#f59e0b')
         .text('PRICE ADJUSTMENTS', 50, yPos);
      
      yPos += 20;

      order.priceAdjustments.forEach((adjustment) => {
        doc.rect(50, yPos, 495, 60)
           .fill('#fef3c7')
           .strokeColor('#f59e0b')
           .stroke();
        
        yPos += 10;
        
        doc.fontSize(9)
           .font('Helvetica')
           .fillColor('#92400e');
        
        doc.text(`Original Amount: NGN ${parseFloat(adjustment.originalAmount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 60, yPos);
        doc.text(`Adjusted Amount: NGN ${parseFloat(adjustment.adjustedAmount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 300, yPos);
        
        yPos += 15;
        doc.text(`Reason: ${adjustment.reason}`, 60, yPos, { width: 470 });
        
        yPos += 15;
        doc.text(`Date: ${new Date(adjustment.createdAt).toLocaleDateString('en-NG')}`, 60, yPos);
        
        yPos += 25;
      });
    }

    // ===== TOTALS SECTION =====
    yPos += 30;
    
    if (yPos > 650) {
      doc.addPage();
      yPos = 50;
    }

    const totalsX = 350;
    const totalsWidth = 195;

    // Subtotal
    doc.rect(totalsX, yPos, totalsWidth, 25)
       .fill('#f9fafb');
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#4b5563')
       .text('Subtotal:', totalsX + 10, yPos + 8);
    
    doc.font('Helvetica-Bold')
       .fillColor('#000')
       .text(
         `NGN ${parseFloat(order.finalAmount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 
         totalsX + 10, 
         yPos + 8, 
         { width: totalsWidth - 20, align: 'right' }
       );

    yPos += 25;

    // Amount Paid
    doc.rect(totalsX, yPos, totalsWidth, 25)
       .fill('#ffffff')
       .strokeColor('#e5e7eb')
       .stroke();
    
    doc.font('Helvetica')
       .fillColor('#4b5563')
       .text('Amount Paid:', totalsX + 10, yPos + 8);
    
    doc.font('Helvetica-Bold')
       .fillColor('#10b981')
       .text(
         `NGN ${parseFloat(order.amountPaid).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 
         totalsX + 10, 
         yPos + 8, 
         { width: totalsWidth - 20, align: 'right' }
       );

    yPos += 25;

    // Balance
    const balance = parseFloat(order.balance);
    const balanceColor = balance > 0 ? '#ef4444' : balance < 0 ? '#f59e0b' : '#10b981';
    
    doc.rect(totalsX, yPos, totalsWidth, 30)
       .fill('#1e40af');
    
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .fillColor('#ffffff')
       .text('BALANCE DUE:', totalsX + 10, yPos + 10);
    
    doc.text(
      `NGN ${Math.abs(balance).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 
      totalsX + 10, 
      yPos + 10, 
      { width: totalsWidth - 20, align: 'right' }
    );

    // ===== PAYMENT STATUS =====
    yPos += 50;
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#4b5563')
       .text(`Payment Status: `, 50, yPos);
    
    doc.font('Helvetica-Bold')
       .fillColor('#000')
       .text(order.paymentStatus, 150, yPos);

    if (order.riteFoodsStatus) {
      yPos += 20;
      doc.font('Helvetica')
         .fillColor('#4b5563')
         .text(`Rite Foods Status: `, 50, yPos);
      
      doc.font('Helvetica-Bold')
         .fillColor('#000')
         .text(order.riteFoodsStatus, 150, yPos);
    }

    if (order.deliveryStatus) {
      yPos += 20;
      doc.font('Helvetica')
         .fillColor('#4b5563')
         .text(`Delivery Status: `, 50, yPos);
      
      doc.font('Helvetica-Bold')
         .fillColor('#000')
         .text(order.deliveryStatus, 150, yPos);
    }

    // ===== FOOTER =====
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#9ca3af')
       .text(
         `Generated on ${new Date().toLocaleString('en-NG', { dateStyle: 'full', timeStyle: 'short' })}`,
         50,
         doc.page.height - 50,
         { align: 'center', width: doc.page.width - 100 }
       );

    doc.end();
  })
);

// @route   GET /api/v1/distribution/dashboard/analytics
// @desc    Get dashboard analytics summary
// @access  Private (Distribution access)
router.get('/dashboard/analytics',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const { days = 30 } = req.query;
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    // Get orders with filters
    const allOrders = await prisma.distributionOrder.findMany({
      where: {
        createdAt: {
          gte: startDate,
          lte: endDate
        }
      },
      include: {
        customer: {
          select: { name: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Calculate stats
    let totalRevenue = 0;
    let totalPacks = 0;
    const customerIds = new Set();

    allOrders.forEach(order => {
      totalRevenue += parseFloat(order.finalAmount?.toString() || '0');
      totalPacks += parseInt(order.totalPacks?.toString() || '0');
      if (order.customerId) {
        customerIds.add(order.customerId);
      }
    });

    // Format recent orders
    const recentOrders = allOrders.slice(0, 10).map(order => ({
      id: order.id,
      orderNumber: order.id.slice(-8).toUpperCase(),
      customer: order.customer?.name || 'Unknown',
      finalAmount: parseFloat(order.finalAmount?.toString() || '0'),
      status: order.status || 'PENDING',
      createdAt: order.createdAt.toISOString()
    }));

    res.json({
      success: true,
      data: {
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        totalOrders: allOrders.length,
        totalPacks,
        activeCustomers: customerIds.size,
        recentOrders
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