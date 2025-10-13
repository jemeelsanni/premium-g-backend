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

// @route   POST /api/v1/warehouse/discounts/request
// @desc    Request discount approval
// @access  Private (Warehouse module access)
router.post('/discounts/request',
  authorizeModule('warehouse', 'write'),
  [
    body('warehouseCustomerId').custom(validateCuid('warehouse customer ID')),
    body('productId').optional().custom(validateCuid('product ID')),
    body('requestedDiscountType').isIn(['PERCENTAGE', 'FIXED_AMOUNT', 'BULK_DISCOUNT']),
    body('requestedDiscountValue').isFloat({ min: 0 }),
    body('minimumQuantity').optional().isInt({ min: 1 }),
    body('maximumDiscountAmount').optional().isFloat({ min: 0 }),
    body('validFrom').isISO8601().withMessage('Valid from date is required'),
    body('validUntil').optional().isISO8601(),
    body('reason').trim().notEmpty().withMessage('Reason is required'),
    body('businessJustification').optional().trim(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      warehouseCustomerId,
      productId,
      requestedDiscountType,
      requestedDiscountValue,
      minimumQuantity,
      maximumDiscountAmount,
      validFrom,
      validUntil,
      reason,
      businessJustification
    } = req.body;

    // Convert date strings to ISO DateTime format
    const validFromDate = new Date(validFrom);
    validFromDate.setHours(0, 0, 0, 0); // Start of day

    let validUntilDate = null;
    if (validUntil) {
      validUntilDate = new Date(validUntil);
      validUntilDate.setHours(23, 59, 59, 999); // End of day
    }

    const discountRequest = await prisma.discountApprovalRequest.create({
      data: {
        warehouseCustomerId,
        productId: productId || null,
        requestedDiscountType,
        requestedDiscountValue: parseFloat(requestedDiscountValue),
        minimumQuantity: minimumQuantity || 1,
        maximumDiscountAmount: maximumDiscountAmount ? parseFloat(maximumDiscountAmount) : null,
        validFrom: validFromDate.toISOString(),
        validUntil: validUntilDate ? validUntilDate.toISOString() : null,
        reason,
        businessJustification: businessJustification || null,
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

// @route   PUT /api/v1/warehouse/discounts/requests/:id/review
// @desc    Approve/Reject discount request (Super Admin only)
// @access  Private (Super Admin)
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
        // Convert dates properly
        const validFromDate = new Date(request.validFrom);
        let validUntilDate = null;
        if (request.validUntil) {
          validUntilDate = new Date(request.validUntil);
        }

        await tx.warehouseCustomerDiscount.create({
          data: {
            warehouseCustomerId: request.warehouseCustomerId,
            productId: request.productId,
            discountType: request.requestedDiscountType,
            discountValue: parseFloat(request.requestedDiscountValue.toString()),
            approvalRequestId: request.id, // Add this field to schema
            minimumQuantity: request.minimumQuantity,
            maximumDiscountAmount: request.maximumDiscountAmount 
              ? parseFloat(request.maximumDiscountAmount.toString()) 
              : null,
            validFrom: validFromDate.toISOString(),
            validUntil: validUntilDate ? validUntilDate.toISOString() : null,
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

// @route   POST /api/v1/warehouse/discounts/check
// @desc    Check discount eligibility for a sale
// @access  Private (Warehouse module access)
router.post('/discounts/check',
  authorizeModule('warehouse'),
  [
    body('warehouseCustomerId').custom(validateCuid('customer ID')),
    body('productId').custom(validateCuid('product ID')),
    body('quantity').isInt({ min: 1 }),
    body('unitPrice').isFloat({ min: 0 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { warehouseCustomerId, productId, quantity, unitPrice } = req.body;

    const discountCheck = await checkCustomerDiscount(
      warehouseCustomerId,
      productId,
      quantity,
      unitPrice
    );

    // ✅ Calculate total savings based on quantity
    const totalSavings = discountCheck.hasDiscount 
      ? parseFloat((quantity * discountCheck.discountAmount).toFixed(2))
      : 0;

    res.json({
      success: true,
      data: {
        ...discountCheck,
        totalSavings // ✅ Add totalSavings to response
      }
    });
  })
);

// Helper function for discount checking
async function checkCustomerDiscount(customerId, productId, quantity, unitPrice) {
  console.log('🔍 ===== DISCOUNT CHECK START =====');
  console.log('🔍 Input params:', {
    customerId,
    productId,
    quantity,
    unitPrice,
    currentTime: new Date()
  });

  // Step 1: Try to find a product-specific discount
  const productSpecificDiscount = await prisma.warehouseCustomerDiscount.findFirst({
    where: {
      warehouseCustomerId: customerId,
      productId: productId,
      status: 'APPROVED',
      minimumQuantity: { lte: quantity },
      validFrom: { lte: new Date() },
      OR: [
        { validUntil: null },
        { validUntil: { gte: new Date() } }
      ]
    },
    include: {
      product: { select: { name: true } },
      approvedByUser: { select: { username: true } }
    },
    orderBy: [
      { priority: 'desc' },
      { createdAt: 'desc' },
      { discountValue: 'desc' }
    ]
  });

  console.log('🔍 Product-specific discount query result:', productSpecificDiscount);

  // Step 2: If no product-specific discount, try general discount
  const generalDiscount = !productSpecificDiscount ?
    await prisma.warehouseCustomerDiscount.findFirst({
      where: {
        warehouseCustomerId: customerId,
        productId: null,
        status: 'APPROVED',
        minimumQuantity: { lte: quantity },
        validFrom: { lte: new Date() },
        OR: [
          { validUntil: null },
          { validUntil: { gte: new Date() } }
        ]
      },
      include: {
        product: { select: { name: true } },
        approvedByUser: { select: { username: true } }
      },
      orderBy: [
        { priority: 'desc' },
        { createdAt: 'desc' },
        { discountValue: 'desc' }
      ]
    }) : null;

  console.log('🔍 General discount query result:', generalDiscount);

  const bestDiscount = productSpecificDiscount || generalDiscount;
  console.log('🔍 Best discount selected:', bestDiscount);

  if (!bestDiscount) {
    console.log('❌ No discount found in database');
    console.log('🔍 ===== DISCOUNT CHECK END =====');
    return {
      hasDiscount: false,
      originalPrice: parseFloat(unitPrice.toFixed(2)),
      finalPrice: parseFloat(unitPrice.toFixed(2)),
      discountAmount: 0,
      discountPercentage: 0
    };
  }

  // Validate minimum quantity
  if (bestDiscount.minimumQuantity && quantity < bestDiscount.minimumQuantity) {
    console.log('❌ Minimum quantity not met:', {
      required: bestDiscount.minimumQuantity,
      provided: quantity
    });
    console.log('🔍 ===== DISCOUNT CHECK END =====');
    return {
      hasDiscount: false,
      originalPrice: parseFloat(unitPrice.toFixed(2)),
      finalPrice: parseFloat(unitPrice.toFixed(2)),
      discountAmount: 0,
      discountPercentage: 0
    };
  }

  // Validate expiry
  if (bestDiscount.validUntil && new Date(bestDiscount.validUntil) < new Date()) {
    console.log('❌ Discount expired:', {
      validUntil: bestDiscount.validUntil,
      now: new Date()
    });
    console.log('🔍 ===== DISCOUNT CHECK END =====');
    return {
      hasDiscount: false,
      originalPrice: parseFloat(unitPrice.toFixed(2)),
      finalPrice: parseFloat(unitPrice.toFixed(2)),
      discountAmount: 0,
      discountPercentage: 0
    };
  }

  let discountAmount = 0;

  if (bestDiscount.discountType === 'PERCENTAGE') {
    discountAmount = (unitPrice * parseFloat(bestDiscount.discountValue.toString())) / 100;
    if (bestDiscount.maximumDiscountAmount) {
      const maxDiscount = parseFloat(bestDiscount.maximumDiscountAmount.toString());
      if (discountAmount > maxDiscount) {
        discountAmount = maxDiscount;
      }
    }
  } else if (bestDiscount.discountType === 'FIXED_AMOUNT') {
    discountAmount = Math.min(parseFloat(bestDiscount.discountValue.toString()), unitPrice);
  }

  const discountedPrice = Math.max(0, unitPrice - discountAmount);

  console.log('✅ Discount calculated successfully:', {
    discountType: bestDiscount.discountType,
    discountValue: bestDiscount.discountValue,
    discountAmount,
    originalPrice: unitPrice,
    discountedPrice,
    percentage: ((discountAmount / unitPrice) * 100).toFixed(2) + '%'
  });
  console.log('🔍 ===== DISCOUNT CHECK END =====');

  return {
    hasDiscount: true,
    originalPrice: parseFloat(unitPrice.toFixed(2)),
    finalPrice: parseFloat(discountedPrice.toFixed(2)),
    discountAmount: parseFloat(discountAmount.toFixed(2)),
    discountPercentage: parseFloat(((discountAmount / unitPrice) * 100).toFixed(2)),
    discount: {
      id: bestDiscount.id,
      type: bestDiscount.discountType,
      value: parseFloat(bestDiscount.discountValue.toString()),
      reason: bestDiscount.reason,
      minimumQuantity: bestDiscount.minimumQuantity,
      maximumDiscountAmount: bestDiscount.maximumDiscountAmount 
        ? parseFloat(bestDiscount.maximumDiscountAmount.toString()) 
        : null,
      validFrom: bestDiscount.validFrom,
      validUntil: bestDiscount.validUntil,
      isProductSpecific: bestDiscount.productId !== null,
      productId: bestDiscount.productId,
      approvedBy: bestDiscount.approvedByUser?.username
    }
  };
}

// Get discount request that created a customer discount
router.get('/discounts/customer-discount/:id/request',
  authorizeModule('warehouse'),
  param('id').custom(validateCuid('customer discount ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    
    const customerDiscount = await prisma.warehouseCustomerDiscount.findUnique({
      where: { id },
      include: {
        // Add relation to approval request if you add the field
        approvalRequest: {
          include: {
            requestedByUser: { select: { username: true } },
            approvedByUser: { select: { username: true } }
          }
        }
      }
    });
    
    res.json({
      success: true,
      data: { customerDiscount }
    });
  })
);

module.exports = { router, checkCustomerDiscount };

module.exports = router;