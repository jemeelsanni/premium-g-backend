// routes/warehouse-discounts.js - New discount management system

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// DISCOUNT APPROVAL REQUEST ROUTES
// ================================

// Request discount approval
router.post('/discounts/request',
  authorizeModule('warehouse', 'write'),
  [
    body('warehouseCustomerId').custom(validateCuid('warehouse customer ID')),
    body('productId').optional().custom(validateCuid('product ID')),
    body('requestedDiscountType').isIn(['PERCENTAGE', 'FIXED_AMOUNT', 'BULK_DISCOUNT']),
    body('requestedDiscountValue').isFloat({ min: 0 }),
    body('minimumQuantity').optional().isInt({ min: 1 }),
    body('maximumDiscountAmount').optional().isFloat({ min: 0 }),
    body('validFrom').isISO8601(),
    body('validUntil').optional().isISO8601(),
    body('reason').trim().notEmpty().withMessage('Reason is required'),
    body('businessJustification').optional().trim(),
    body('estimatedImpact').optional().isFloat()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const discountRequest = await prisma.discountApprovalRequest.create({
      data: {
        ...req.body,
        requestedBy: req.user.id
      },
      include: {
        warehouseCustomer: { select: { name: true } },
        product: { select: { name: true, productNo: true } },
        requestedByUser: { select: { username: true } }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Discount approval request submitted successfully',
      data: { discountRequest }
    });
  })
);

// Get discount approval requests (Admin only)
router.get('/discounts/requests',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [
    query('status').optional().isIn(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  asyncHandler(async (req, res) => {
    const {
      status = 'PENDING',
      page = 1,
      limit = 20
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};
    if (status) where.status = status;

    // Add 24-hour filter
const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
where.createdAt = { gte: twentyFourHoursAgo };

const [requests, total] = await Promise.all([
  prisma.discountApprovalRequest.findMany({
    where,
    include: {
      warehouseCustomer: { select: { name: true, customerType: true } },
      product: { select: { name: true, productNo: true } },
      requestedByUser: { select: { username: true } },
      approvedByUser: { select: { username: true } }
    },
    orderBy: { createdAt: 'desc' },
    skip,
    take
  }),
  prisma.discountApprovalRequest.count({ where })
]);


    res.json({
      success: true,
      data: {
        requests,
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

// Approve/Reject discount request (Super Admin only)
router.put('/discounts/requests/:id/review',
  authorizeRole(['SUPER_ADMIN']),
  param('id').custom(validateCuid('request ID')),
  [
    body('action').isIn(['approve', 'reject']),
    body('adminNotes').optional().trim(),
    body('rejectionReason').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { action, adminNotes, rejectionReason } = req.body;

    const request = await prisma.discountApprovalRequest.findUnique({
      where: { id }
    });

    if (!request) {
      throw new NotFoundError('Discount request not found');
    }

    if (request.status !== 'PENDING') {
      throw new BusinessError('Request has already been processed');
    }

    const result = await prisma.$transaction(async (tx) => {
      // Update request status
      const updatedRequest = await tx.discountApprovalRequest.update({
        where: { id },
        data: {
          status: action === 'approve' ? 'APPROVED' : 'REJECTED',
          approvedBy: req.user.id,
          approvedAt: new Date(),
          adminNotes,
          rejectionReason: action === 'reject' ? rejectionReason : null
        },
        include: {
          warehouseCustomer: { select: { name: true } },
          product: { select: { name: true } }
        }
      });

      // If approved, create the customer discount
      if (action === 'approve') {
        await tx.warehouseCustomerDiscount.create({
          data: {
            warehouseCustomerId: request.warehouseCustomerId,
            productId: request.productId,
            discountType: request.requestedDiscountType,
            discountValue: request.requestedDiscountValue,
            minimumQuantity: request.minimumQuantity,
            maximumDiscountAmount: request.maximumDiscountAmount,
            validFrom: request.validFrom,
            validUntil: request.validUntil,
            reason: request.reason,
            notes: adminNotes,
            status: 'APPROVED',
            requestedBy: request.requestedBy,
            approvedBy: req.user.id,
            approvedAt: new Date()
          }
        });
      }

      return updatedRequest;
    });

    res.json({
      success: true,
      message: `Discount request ${action}d successfully`,
      data: { request: result }
    });
  })
);

// ================================
// CUSTOMER DISCOUNT MANAGEMENT
// ================================

// Get customer discounts
router.get('/customers/:customerId/discounts',
  authorizeModule('warehouse'),
  param('customerId').custom(validateCuid('customer ID')),
  asyncHandler(async (req, res) => {
    const { customerId } = req.params;
    const { status = 'APPROVED' } = req.query;

    const discounts = await prisma.warehouseCustomerDiscount.findMany({
      where: {
        warehouseCustomerId: customerId,
        status,
        // Only show current and future discounts
        OR: [
          { validUntil: null },
          { validUntil: { gte: new Date() } }
        ]
      },
      include: {
        product: { select: { name: true, productNo: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: { discounts }
    });
  })
);

// Check if customer qualifies for discount
router.post('/discounts/check',
  authorizeModule('warehouse'),
  [
    body('warehouseCustomerId').custom(validateCuid('customer ID')),
    body('productId').custom(validateCuid('product ID')),
    body('quantity').isInt({ min: 1 }),
    body('unitPrice').isFloat({ min: 0 })
  ],
  asyncHandler(async (req, res) => {
    const { warehouseCustomerId, productId, quantity, unitPrice } = req.body;

    // Find applicable discounts
    const applicableDiscounts = await prisma.warehouseCustomerDiscount.findMany({
      where: {
        warehouseCustomerId,
        status: 'APPROVED',
        OR: [
          { productId }, // Product-specific discount
          { productId: null } // General discount
        ],
        minimumQuantity: { lte: quantity },
        validFrom: { lte: new Date() },
        OR: [
          { validUntil: null },
          { validUntil: { gte: new Date() } }
        ],
        // Check usage limits
        OR: [
          { usageLimit: null },
          { usageCount: { lt: prisma.raw('usage_limit') } }
        ]
      },
      include: {
        product: { select: { name: true } }
      },
      orderBy: [
        { productId: 'desc' }, // Product-specific discounts first
        { discountValue: 'desc' } // Higher discounts first
      ]
    });

    if (applicableDiscounts.length === 0) {
      return res.json({
        success: true,
        data: {
          hasDiscount: false,
          originalPrice: unitPrice,
          finalPrice: unitPrice,
          discountAmount: 0,
          message: 'No applicable discounts found'
        }
      });
    }

    // Apply the best discount (first in sorted order)
    const bestDiscount = applicableDiscounts[0];
    let discountAmount = 0;
    let discountedPrice = unitPrice;

    if (bestDiscount.discountType === 'PERCENTAGE') {
      discountAmount = (unitPrice * bestDiscount.discountValue) / 100;
      // Apply maximum discount cap if set
      if (bestDiscount.maximumDiscountAmount && discountAmount > bestDiscount.maximumDiscountAmount) {
        discountAmount = bestDiscount.maximumDiscountAmount;
      }
    } else if (bestDiscount.discountType === 'FIXED_AMOUNT') {
      discountAmount = Math.min(bestDiscount.discountValue, unitPrice);
    }

    discountedPrice = Math.max(0, unitPrice - discountAmount);

    res.json({
      success: true,
      data: {
        hasDiscount: true,
        originalPrice: parseFloat(unitPrice.toFixed(2)),
        finalPrice: parseFloat(discountedPrice.toFixed(2)),
        discountAmount: parseFloat(discountAmount.toFixed(2)),
        discountPercentage: parseFloat(((discountAmount / unitPrice) * 100).toFixed(2)),
        totalSavings: parseFloat((discountAmount * quantity).toFixed(2)),
        discount: {
          id: bestDiscount.id,
          type: bestDiscount.discountType,
          value: bestDiscount.discountValue,
          reason: bestDiscount.reason,
          productSpecific: bestDiscount.productId !== null
        }
      }
    });
  })
);

module.exports = router;