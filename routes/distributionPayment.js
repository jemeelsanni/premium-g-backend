const express = require('express');
const { body, param, validationResult } = require('express-validator');
const router = express.Router();
const distributionPaymentService = require('../services/distributionPaymentService');
const distributionDeliveryService = require('../services/distributionDeliveryService');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorizeModule } = require('../middleware/auth');
const { ValidationError } = require('../middleware/errorHandler');

// Helper for validation
const validateCuid = (field) => {
  return (value) => {
    if (!/^c[a-z0-9]{24,25}$/i.test(value)) {
      throw new Error(`Invalid ${field}`);
    }
    return true;
  };
};

// ================================
// PAYMENT ROUTES
// ================================

// @route   POST /api/v1/distribution/payments/record
// @desc    Record customer payment (Sales Rep or Cashier)
// @access  Private (Distribution write access)
router.post('/payments/record',
  authorizeModule('distribution', 'write'),
  [
    body('orderId').custom(validateCuid('order ID')),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
    body('paymentMethod').isIn(['BANK_TRANSFER', 'CASH', 'CHECK', 'WHATSAPP_TRANSFER', 'POS', 'MOBILE_MONEY']),
    body('reference').optional().trim(),
    body('paidBy').optional().trim(),
    body('receivedBy').trim().notEmpty().withMessage('Received by is required'),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      orderId,
      amount,
      paymentMethod,
      reference,
      paidBy,
      receivedBy,
      notes
    } = req.body;

    const result = await distributionPaymentService.recordCustomerPayment({
      orderId,
      amount,
      paymentMethod,
      reference,
      paidBy,
      receivedBy,
      notes,
      userId: req.user.id
    });

    res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',
      data: result
    });
  })
);

// @route   POST /api/v1/distribution/payments/confirm
// @desc    Confirm payment (Accountant only)
// @access  Private (Admin or Accountant)
router.post('/payments/confirm',
  authorizeModule('distribution', 'admin'),
  [
    body('orderId').custom(validateCuid('order ID')),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    // Check if user is accountant or admin
    if (!['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'CASHIER'].includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Only accountants and admins can confirm payments'
      });
    }

    const { orderId, notes } = req.body;

    const order = await distributionPaymentService.confirmPayment(
      orderId,
      req.user.id,
      notes
    );

    res.json({
      success: true,
      message: 'Payment confirmed successfully. Ready to send to Rite Foods.',
      data: { order }
    });
  })
);

// @route   POST /api/v1/distribution/payments/rite-foods
// @desc    Record payment to Rite Foods (Admin only)
// @access  Private (Admin)
router.post('/payments/rite-foods',
  authorizeModule('distribution', 'admin'),
  [
    body('orderId').custom(validateCuid('order ID')),
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
    body('paymentMethod').isIn(['BANK_TRANSFER', 'CHECK']),
    body('reference').trim().notEmpty().withMessage('Payment reference is required'),
    body('riteFoodsOrderNumber').optional().trim(),
    body('riteFoodsInvoiceNumber').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      orderId,
      amount,
      paymentMethod,
      reference,
      riteFoodsOrderNumber,
      riteFoodsInvoiceNumber
    } = req.body;

    const result = await distributionPaymentService.recordPaymentToRiteFoods({
      orderId,
      amount,
      paymentMethod,
      reference,
      riteFoodsOrderNumber,
      riteFoodsInvoiceNumber,
      userId: req.user.id
    });

    res.status(201).json({
      success: true,
      message: 'Payment to Rite Foods recorded successfully',
      data: result
    });
  })
);

// @route   PUT /api/v1/distribution/payments/rite-foods/status
// @desc    Update Rite Foods order status (Admin only)
// @access  Private (Admin)
router.put('/payments/rite-foods/status',
  authorizeModule('distribution', 'admin'),
  [
    body('orderId').custom(validateCuid('order ID')),
    body('riteFoodsStatus').isIn(['PAYMENT_SENT', 'ORDER_RAISED', 'PROCESSING', 'LOADED', 'DISPATCHED']),
    body('orderRaisedAt').optional().isISO8601(),
    body('loadedDate').optional().isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      orderId,
      riteFoodsStatus,
      orderRaisedAt,
      loadedDate
    } = req.body;

    const order = await distributionPaymentService.updateRiteFoodsStatus({
      orderId,
      riteFoodsStatus,
      orderRaisedAt: orderRaisedAt ? new Date(orderRaisedAt) : null,
      loadedDate: loadedDate ? new Date(loadedDate) : null,
      userId: req.user.id
    });

    res.json({
      success: true,
      message: 'Rite Foods status updated successfully',
      data: { order }
    });
  })
);

// @route   GET /api/v1/distribution/payments/:orderId/summary
// @desc    Get payment summary for an order
// @access  Private (Distribution access)
router.get('/payments/:orderId/summary',
  authorizeModule('distribution'),
  [
    param('orderId').custom(validateCuid('order ID'))
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { orderId } = req.params;

    const summary = await distributionPaymentService.getOrderPaymentSummary(orderId);

    res.json({
      success: true,
      data: summary
    });
  })
);

// @route   GET /api/v1/distribution/payments/pending
// @desc    Get orders with pending payments (for accountant dashboard)
// @access  Private (Admin)
router.get('/payments/pending',
  authorizeModule('distribution', 'admin'),
  asyncHandler(async (req, res) => {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const pendingOrders = await prisma.distributionOrder.findMany({
      where: {
        paymentStatus: { in: ['PENDING', 'PARTIAL'] }
      },
      include: {
        customer: {
          select: { name: true, phone: true }
        },
        location: {
          select: { name: true }
        },
        paymentHistory: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const formattedOrders = pendingOrders.map(order => ({
      id: order.id,
      customer: order.customer.name,
      customerPhone: order.customer.phone,
      location: order.location.name,
      totalAmount: parseFloat(order.finalAmount),
      amountPaid: parseFloat(order.amountPaid),
      balance: parseFloat(order.balance),
      paymentStatus: order.paymentStatus,
      lastPayment: order.paymentHistory[0] ? {
        amount: parseFloat(order.paymentHistory[0].amount),
        date: order.paymentHistory[0].createdAt
      } : null,
      createdAt: order.createdAt
    }));

    res.json({
      success: true,
      data: {
        orders: formattedOrders,
        count: formattedOrders.length
      }
    });
  })
);

// ================================
// DELIVERY ROUTES
// ================================

// @route   POST /api/v1/distribution/delivery/assign-transport
// @desc    Assign transport details to order
// @access  Private (Distribution write access)
router.post('/delivery/assign-transport',
  authorizeModule('distribution', 'admin'),  // ✅ Only admins (not just 'write')
  [
    body('orderId').custom(validateCuid('order ID')),
    body('transporterCompany').trim().notEmpty().withMessage('Transporter company is required'),
    body('driverNumber').trim().notEmpty().withMessage('Driver number is required'),
    body('truckNumber').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { orderId, transporterCompany, driverNumber, truckNumber } = req.body;

    // ✅ CRITICAL: Validate order is ready for transport
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        location: true
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // ✅ Check 1: Payment must be confirmed
    if (order.paymentStatus !== 'CONFIRMED') {
      throw new BusinessError(
        'Cannot assign transport: Customer payment must be confirmed by accountant first',
        'PAYMENT_NOT_CONFIRMED'
      );
    }

    // ✅ Check 2: Must have paid Rite Foods
    if (!order.paidToRiteFoods) {
      throw new BusinessError(
        'Cannot assign transport: Payment to Rite Foods must be completed first',
        'RITE_FOODS_NOT_PAID'
      );
    }

    // ✅ Check 3: Order must be loaded at Rite Foods
    if (order.riteFoodsStatus !== 'LOADED' && order.riteFoodsStatus !== 'DISPATCHED') {
      throw new BusinessError(
        `Cannot assign transport: Order must be loaded at Rite Foods first. Current status: ${order.riteFoodsStatus}`,
        'ORDER_NOT_LOADED'
      );
    }

    // ✅ Check 4: Balance must be zero (no outstanding payment)
    if (parseFloat(order.balance) !== 0) {
      throw new BusinessError(
        `Cannot assign transport: Order has outstanding balance of ₦${order.balance}. Customer must settle balance first.`,
        'OUTSTANDING_BALANCE'
      );
    }

    // ✅ Check 5: Transport not already assigned
    if (order.transporterCompany) {
      throw new BusinessError(
        'Transport already assigned to this order',
        'TRANSPORT_ALREADY_ASSIGNED'
      );
    }

    // All checks passed - assign transport
    const updatedOrder = await distributionDeliveryService.assignTransport({
      orderId,
      transporterCompany,
      driverNumber,
      truckNumber,
      userId: req.user.id
    });

    res.json({
      success: true,
      message: 'Transport assigned successfully. Order status updated to IN_TRANSIT.',
      data: { order: updatedOrder }
    });
  })
);

// @route   POST /api/v1/distribution/delivery/record
// @desc    Record delivery outcome (full, partial, or failed)
// @access  Private (Distribution admin)
router.post('/delivery/record',
  authorizeModule('distribution', 'admin'),
  [
    body('orderId').custom(validateCuid('order ID')),
    body('deliveryStatus').isIn(['FULLY_DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED']),
    body('deliveredPallets').optional().isInt({ min: 0 }),
    body('deliveredPacks').optional().isInt({ min: 0 }),
    body('deliveredBy').trim().notEmpty().withMessage('Delivered by is required'),
    body('deliveryNotes').optional().trim(),
    body('nonDeliveryReason').optional().trim(),
    body('partialDeliveryReason').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      orderId,
      deliveryStatus,
      deliveredPallets,
      deliveredPacks,
      deliveredBy,
      deliveryNotes,
      nonDeliveryReason,
      partialDeliveryReason
    } = req.body;

    const order = await distributionDeliveryService.recordDelivery({
      orderId,
      deliveryStatus,
      deliveredPallets,
      deliveredPacks,
      deliveredBy,
      deliveryNotes,
      nonDeliveryReason,
      partialDeliveryReason,
      reviewerId: req.user.id
    });

    res.json({
      success: true,
      message: 'Delivery recorded successfully',
      data: { order }
    });
  })
);

// @route   GET /api/v1/distribution/delivery/:orderId/summary
// @desc    Get delivery summary for an order
// @access  Private (Distribution access)
router.get('/delivery/:orderId/summary',
  authorizeModule('distribution'),
  [
    param('orderId').custom(validateCuid('order ID'))
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { orderId } = req.params;

    const summary = await distributionDeliveryService.getDeliverySummary(orderId);

    res.json({
      success: true,
      data: summary
    });
  })
);

// @route   GET /api/v1/distribution/delivery/in-transit
// @desc    Get all orders currently in transit
// @access  Private (Distribution access)
router.get('/delivery/in-transit',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const inTransitOrders = await prisma.distributionOrder.findMany({
      where: {
        deliveryStatus: 'IN_TRANSIT'
      },
      include: {
        customer: {
          select: { name: true, phone: true }
        },
        location: {
          select: { name: true, address: true }
        }
      },
      orderBy: { updatedAt: 'desc' }
    });

    const formattedOrders = inTransitOrders.map(order => ({
      id: order.id,
      customer: order.customer.name,
      customerPhone: order.customer.phone,
      location: order.location.name,
      locationAddress: order.location.address,
      transporter: order.transporterCompany,
      driver: order.driverNumber,
      truck: order.truckNumber,
      totalPallets: order.totalPallets,
      totalPacks: order.totalPacks,
      amount: parseFloat(order.finalAmount),
      createdAt: order.createdAt
    }));

    res.json({
      success: true,
      data: {
        orders: formattedOrders,
        count: formattedOrders.length
      }
    });
  })
);

// @route   GET /api/v1/distribution/delivery/pending-review
// @desc    Get orders pending delivery review
// @access  Private (Distribution admin)
router.get('/delivery/pending-review',
  authorizeModule('distribution', 'admin'),
  asyncHandler(async (req, res) => {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();

    const pendingReview = await prisma.distributionOrder.findMany({
      where: {
        status: 'IN_TRANSIT',
        deliveryStatus: { in: ['IN_TRANSIT', 'PENDING'] }
      },
      include: {
        customer: {
          select: { name: true, phone: true }
        },
        location: {
          select: { name: true }
        }
      },
      orderBy: { updatedAt: 'asc' }
    });

    const formattedOrders = pendingReview.map(order => ({
      id: order.id,
      customer: order.customer.name,
      location: order.location.name,
      transporter: order.transporterCompany,
      driver: order.driverNumber,
      truck: order.truckNumber,
      totalPallets: order.totalPallets,
      totalPacks: order.totalPacks,
      amount: parseFloat(order.finalAmount),
      daysSinceDispatch: Math.floor((new Date() - new Date(order.updatedAt)) / (1000 * 60 * 60 * 24))
    }));

    res.json({
      success: true,
      data: {
        orders: formattedOrders,
        count: formattedOrders.length
      }
    });
  })
);

module.exports = router;