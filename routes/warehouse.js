const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

const warehouseCustomersRouter = require('./warehouse-customers');
router.use('/', warehouseCustomersRouter);

// Include expense management routes
const warehouseExpensesRouter = require('./warehouse-expenses');
router.use('/', warehouseExpensesRouter);

// Include discount management routes (if created)
try {
  const warehouseDiscountsRouter = require('./warehouse-discounts');
  router.use('/', warehouseDiscountsRouter);
} catch (error) {
  console.log('Warehouse discounts router not found, skipping...');
}


// ================================
// VALIDATION RULES
// ================================

const createWarehouseSaleValidation = [
  body('productId').custom(validateCuid('product ID')),
  body('quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
  body('unitType').isIn(['PALLETS', 'PACKS', 'UNITS']).withMessage('Invalid unit type'),
  body('unitPrice').isDecimal({ decimal_digits: '0,2' }).withMessage('Valid unit price required'),
  body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']).withMessage('Invalid payment method'),
  body('customerName').optional().isLength({ max: 200 }),
  body('customerPhone').optional().isLength({ max: 20 })
];

const createCashFlowValidation = [
  body('transactionType').isIn(['CASH_IN', 'CASH_OUT', 'SALE', 'EXPENSE', 'ADJUSTMENT']).withMessage('Invalid transaction type'),
  body('amount').isDecimal({ decimal_digits: '0,2' }).withMessage('Valid amount required'),
  body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']).withMessage('Invalid payment method'),
  body('description').optional().isLength({ max: 500 }),
  body('referenceNumber').optional().isLength({ max: 50 })
];

const updateInventoryValidation = [
  body('pallets').optional().isInt({ min: 0 }),
  body('packs').optional().isInt({ min: 0 }),
  body('units').optional().isInt({ min: 0 }),
  body('reorderLevel').optional().isInt({ min: 0 }),
  body('maxStockLevel').optional().isInt({ min: 0 }),
  body('location').optional().isLength({ max: 100 })
];

// ================================
// UTILITY FUNCTIONS
// ================================

const isReceiptNumberConflict = (error) => {
  if (!error || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes('receipt_number');
  }
  if (typeof target === 'string') {
    return target.includes('receipt_number');
  }
  return false;
};

const dropReceiptNumberConstraintIfExists = async () => {
  try {
    await prisma.$executeRaw`DROP INDEX IF EXISTS "warehouse_sales_receipt_number_key"`;
  } catch (dropError) {
    console.error('Failed to drop receipt number unique index', dropError);
  }
};

const withReceiptConflictRetry = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    if (isReceiptNumberConflict(error)) {
      await dropReceiptNumberConstraintIfExists();
      return operation();
    }
    throw error;
  }
};

const generateReceiptNumber = async () => {
  const prefix = 'WHS';
  const date = new Date();
  const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  
  const lastReceipt = await prisma.warehouseSale.findFirst({
    where: {
      receiptNumber: { startsWith: `${prefix}-${dateStr}` }
    },
    orderBy: { createdAt: 'desc' }
  });

  let sequence = 1;
  if (lastReceipt) {
    const lastSequence = parseInt(lastReceipt.receiptNumber.split('-')[2]);
    sequence = lastSequence + 1;
  }

  return `${prefix}-${dateStr}-${String(sequence).padStart(4, '0')}`;
};

const updateInventoryAfterSale = async (productId, quantity, unitType, tx) => {
  const inventory = await tx.warehouseInventory.findFirst({
    where: { productId }
  });

  if (!inventory) {
    throw new BusinessError('Product not found in inventory', 'PRODUCT_NOT_FOUND');
  }

  const updateData = {};
  
  switch (unitType) {
    case 'PALLETS':
      if (inventory.pallets < quantity) {
        throw new BusinessError('Insufficient pallets in inventory', 'INSUFFICIENT_STOCK');
      }
      updateData.pallets = inventory.pallets - quantity;
      break;
    case 'PACKS':
      if (inventory.packs < quantity) {
        throw new BusinessError('Insufficient packs in inventory', 'INSUFFICIENT_STOCK');
      }
      updateData.packs = inventory.packs - quantity;
      break;
    case 'UNITS':
      if (inventory.units < quantity) {
        throw new BusinessError('Insufficient units in inventory', 'INSUFFICIENT_STOCK');
      }
      updateData.units = inventory.units - quantity;
      break;
  }

  await tx.warehouseInventory.update({
    where: { id: inventory.id },
    data: updateData
  });
};


router.use('/', warehouseCustomersRouter);

// ================================
// INVENTORY ROUTES
// ================================

// @route   GET /api/v1/warehouse/inventory
// @desc    Get warehouse inventory with filtering
// @access  Private (Warehouse module access)
router.get('/inventory', asyncHandler(async (req, res) => {
  const { productId, location, lowStock } = req.query;

  const where = {};

  if (productId) where.productId = productId;
  if (location) where.location = location;
  
  // Low stock filter
  if (lowStock === 'true') {
    where.packs = { lte: prisma.raw('reorder_level') };
  }

  const inventory = await prisma.warehouseInventory.findMany({
    where,
    include: {
      product: true
    },
    orderBy: { lastUpdated: 'desc' }
  });

  res.json({
    success: true,
    data: inventory 
  });
}));

// @route   PUT /api/v1/warehouse/inventory/:id
// @desc    Update inventory levels
// @access  Private (Warehouse Admin)
router.put('/inventory/:id',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  param('id').custom(validateCuid('inventory ID')),
  [
    body('pallets').optional().isInt({ min: 0 }),
    body('packs').optional().isInt({ min: 0 }),
    body('units').optional().isInt({ min: 0 }),
    body('reorderLevel').optional().isInt({ min: 0 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;

    const inventory = await prisma.warehouseInventory.update({
      where: { id },
      data: updateData,
      include: {
        product: true
      }
    });

    res.json({
      success: true,
      message: 'Inventory updated successfully',
      data: { inventory }
    });
  })
);

// @route   GET /api/v1/warehouse/products
// @desc    Get products available for warehouse
// @access  Private (Warehouse module access)
// Add this to routes/warehouse.js
router.get('/products', asyncHandler(async (req, res) => {
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      module: 'WAREHOUSE'
    },
    orderBy: { name: 'asc' }
  });

  res.json({
    success: true,
    data: { products }
  });
}));

// ================================
// WAREHOUSE SALES ROUTES
// ================================

// @route   GET /api/v1/warehouse/sales
// @desc    Get warehouse sales with filtering and pagination
// @access  Private (Warehouse module access)
router.get('/sales',
  authorizeModule('warehouse'),
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('customerId').optional(),
    query('productId').optional(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const {
      page = '1',
      limit = '10',
      customerId,
      productId,
      startDate,
      endDate
    } = req.query;

    const pageNumber = parseInt(page, 10);
    const pageSize = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageSize;
    const take = pageSize;

    const baseWhere = {};

    if (customerId) {
      baseWhere.warehouseCustomerId = customerId;
    }

    if (startDate || endDate) {
      baseWhere.createdAt = {};
      if (startDate) baseWhere.createdAt.gte = new Date(startDate);
      if (endDate) baseWhere.createdAt.lte = new Date(endDate);
    }

    const groupWhere = { ...baseWhere };
    if (productId) {
      groupWhere.productId = productId;
    }

    const totalGroups = await prisma.warehouseSale.groupBy({
      where: groupWhere,
      by: ['receiptNumber']
    });
    const total = totalGroups.length;

    if (total === 0) {
      return res.json({
        success: true,
        data: {
          sales: [],
          pagination: {
            page: pageNumber,
            limit: pageSize,
            total: 0,
            totalPages: 0
          }
        }
      });
    }

    const groupedReceipts = await prisma.warehouseSale.groupBy({
      where: groupWhere,
      by: ['receiptNumber'],
      orderBy: {
        _max: { createdAt: 'desc' }
      },
      skip,
      take,
      _max: { createdAt: true }
    });

    const receiptNumbers = groupedReceipts.map(group => group.receiptNumber);

    if (receiptNumbers.length === 0) {
      return res.json({
        success: true,
        data: {
          sales: [],
          pagination: {
            page: pageNumber,
            limit: pageSize,
            total,
            totalPages: Math.ceil(total / pageSize)
          }
        }
      });
    }

    const latestCreatedMap = new Map(groupedReceipts.map(group => [group.receiptNumber, group._max.createdAt]));

    const sales = await prisma.warehouseSale.findMany({
      where: {
        ...baseWhere,
        receiptNumber: { in: receiptNumbers }
      },
      include: {
        product: { select: { name: true, productNo: true } },
        warehouseCustomer: { select: { id: true, name: true, phone: true } },
        salesOfficerUser: { select: { id: true, username: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    const aggregateMap = new Map();

    for (const sale of sales) {
      const key = sale.receiptNumber;
      const aggregate = aggregateMap.get(key) || {
        receiptNumber: key,
        saleIds: [],
        warehouseCustomerId: sale.warehouseCustomerId,
        customerName: sale.customerName || sale.warehouseCustomer?.name || null,
        customerPhone: sale.customerPhone || sale.warehouseCustomer?.phone || null,
        paymentMethod: sale.paymentMethod,
        salesOfficer: sale.salesOfficer,
        salesOfficerUser: sale.salesOfficerUser,
        warehouseCustomer: sale.warehouseCustomer,
        totalAmount: 0,
        totalDiscountAmount: 0,
        totalCost: 0,
        grossProfit: 0,
        discountApplied: false,
        createdAt: latestCreatedMap.get(key) || sale.createdAt,
        items: []
      };

      aggregate.saleIds.push(sale.id);
      aggregate.totalAmount += Number(sale.totalAmount);
      aggregate.totalDiscountAmount += Number(sale.totalDiscountAmount || 0);
      aggregate.totalCost += Number(sale.totalCost || 0);
      aggregate.grossProfit += Number(sale.grossProfit || 0);
      aggregate.discountApplied = aggregate.discountApplied || sale.discountApplied;

      if (!aggregate.customerName) {
        aggregate.customerName = sale.customerName || sale.warehouseCustomer?.name || null;
      }

      if (!aggregate.customerPhone) {
        aggregate.customerPhone = sale.customerPhone || sale.warehouseCustomer?.phone || null;
      }

      if (!aggregate.warehouseCustomer && sale.warehouseCustomer) {
        aggregate.warehouseCustomer = sale.warehouseCustomer;
      }

      aggregate.items.push({
        id: sale.id,
        productId: sale.productId,
        product: sale.product,
        quantity: sale.quantity,
        unitType: sale.unitType,
        unitPrice: Number(sale.unitPrice),
        totalAmount: Number(sale.totalAmount),
        totalDiscountAmount: sale.totalDiscountAmount ? Number(sale.totalDiscountAmount) : 0,
        discountApplied: sale.discountApplied,
        discountPercentage: sale.discountPercentage ? Number(sale.discountPercentage) : null,
        originalUnitPrice: sale.originalUnitPrice ? Number(sale.originalUnitPrice) : null,
        costPerUnit: Number(sale.costPerUnit || 0),
        totalCost: Number(sale.totalCost || 0),
        grossProfit: Number(sale.grossProfit || 0)
      });

      aggregateMap.set(key, aggregate);
    }

    const aggregatedSales = receiptNumbers
      .map(receipt => aggregateMap.get(receipt))
      .filter(Boolean)
      .map(aggregate => ({
        ...aggregate,
        totalQuantity: aggregate.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        itemsCount: aggregate.items.length
      }));

    res.json({
      success: true,
      data: {
        sales: aggregatedSales,
        pagination: {
          page: pageNumber,
          limit: pageSize,
          total,
          totalPages: Math.ceil(total / pageSize)
        }
      }
    });
  })
);

// @route   POST /api/v1/warehouse/sales
// @desc    Create warehouse sale with cost tracking and profit calculation
// @access  Private (Warehouse Sales Officer, Admin)
router.post('/sales',
  authorizeModule('warehouse', 'write'),
  [
    body('productId').custom(validateCuid('product ID')),
    body('quantity').isInt({ min: 1 }).withMessage('Quantity must be greater than 0'),
    body('unitType').isIn(['PALLETS', 'PACKS', 'UNITS']).withMessage('Invalid unit type'),
    body('unitPrice').isFloat({ min: 0 }).withMessage('Unit price must be 0 or greater'),
    body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
   body('warehouseCustomerId').optional().custom(validateCuid('warehouse customer ID')),
    body('customerName').optional().trim(), // For backward compatibility
    body('customerPhone').optional().trim(), // For backward compatibility
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      productId,
      quantity,
      unitType,
      unitPrice,
      paymentMethod,
      warehouseCustomerId,
      customerName,
      customerPhone
    } = req.body;

    let customerId = warehouseCustomerId;
    
    if (!customerId && customerName) {
      // Check if customer exists by name/phone
      let existingCustomer = await prisma.warehouseCustomer.findFirst({
        where: {
          name: customerName,
          phone: customerPhone || null
        }
      });

      if (!existingCustomer) {
        // Create new customer
        existingCustomer = await prisma.warehouseCustomer.create({
          data: {
            name: customerName,
            phone: customerPhone,
            customerType: 'INDIVIDUAL',
            createdBy: req.user.id
          }
        });
      }
      
      customerId = existingCustomer.id;
    }

    // Get product for cost calculation
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    // Calculate costs and profit
    const totalAmount = parseFloat((quantity * unitPrice).toFixed(2));
    const costPerUnit = parseFloat(product.costPerPack || 0);
    const totalCost = parseFloat((quantity * costPerUnit).toFixed(2));
    const grossProfit = parseFloat((totalAmount - totalCost).toFixed(2));
    const profitMargin = totalAmount > 0 ? (grossProfit / totalAmount) * 100 : 0;

    const providedReceiptNumber = req.body.receiptNumber;
    const receiptNumber = providedReceiptNumber || await generateReceiptNumber();

    const createSaleOperation = () => prisma.$transaction(async (tx) => {
      // Create warehouse sale
      const warehouseSale = await tx.warehouseSale.create({
        data: {
          productId,
          quantity,
          unitType,
          unitPrice,
          totalAmount,
          costPerUnit,
          totalCost,
          grossProfit,
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          paymentMethod,
          warehouseCustomerId: customerId,
          customerName,
          customerPhone,
          receiptNumber,
          salesOfficer: req.user.id
        },
        include: {
          product: true,
          warehouseCustomer: true,
          salesOfficerUser: {
            select: { id: true, username: true }
          }
        }
      });

      // Update inventory (if tracking by packs)
      if (unitType === 'PACKS') {
        await tx.warehouseInventory.updateMany({
          where: { productId },
          data: {
            packs: { decrement: quantity }
          }
        });
      }

      if (customerId) {
        const customerStats = await tx.warehouseCustomer.update({
          where: { id: customerId },
          data: {
            totalPurchases: { increment: 1 },
            totalSpent: { increment: totalAmount },
            lastPurchaseDate: new Date()
          },
          select: {
            totalPurchases: true,
            totalSpent: true
          }
        });

        const totalSpentValue = parseFloat(customerStats.totalSpent.toString());
        const averageOrderValue = customerStats.totalPurchases > 0
          ? parseFloat((totalSpentValue / customerStats.totalPurchases).toFixed(2))
          : 0;

        await tx.warehouseCustomer.update({
          where: { id: customerId },
          data: {
            averageOrderValue
          }
        });
      }

      return warehouseSale;
    });

    const sale = await withReceiptConflictRetry(() => createSaleOperation());

    res.status(201).json({
      success: true,
      message: 'Warehouse sale recorded successfully',
      data: { sale }
    });
  })
);

// @route   GET /api/v1/warehouse/sales
// @desc    Get warehouse sales with filtering and pagination
// @access  Private (Warehouse module access)
router.post('/sales',
  authorizeModule('warehouse', 'write'),
  [
    body('warehouseCustomerId').optional().custom(validateCuid('warehouse customer ID')),
    body('productId').custom(validateCuid('product ID')),
    body('quantity').isInt({ min: 1 }),
    body('unitType').isIn(['PALLETS', 'PACKS', 'UNITS']),
    body('unitPrice').isFloat({ min: 0 }),
    body('applyDiscount').optional().isBoolean(),
    body('requestDiscountApproval').optional().isBoolean(), // For on-the-spot discount requests
    body('discountReason').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      productId,
      quantity,
      unitType,
      unitPrice,
      paymentMethod,
      warehouseCustomerId,
      customerName,
      customerPhone,
      applyDiscount = false,
      requestDiscountApproval = false,
      discountReason
    } = req.body;

    // Handle customer creation if needed
    let customerId = warehouseCustomerId;
    
    if (!customerId && customerName) {
      // Check if customer exists by name/phone
      let existingCustomer = await prisma.warehouseCustomer.findFirst({
        where: {
          name: customerName,
          phone: customerPhone || null
        }
      });

      if (!existingCustomer) {
        // Create new customer
        existingCustomer = await prisma.warehouseCustomer.create({
          data: {
            name: customerName,
            phone: customerPhone,
            customerType: 'INDIVIDUAL',
            createdBy: req.user.id
          }
        });
      }
      
      customerId = existingCustomer.id;
    }

    // Get product for cost calculation
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    // Initialize pricing
    let originalUnitPrice = unitPrice;
    let finalUnitPrice = unitPrice;
    let discountAmount = 0;
    let discountPercentage = 0;
    let applicableDiscount = null;
    let requiresApproval = false;

    // Check for applicable discounts if customer exists and applyDiscount is true
    if (customerId && applyDiscount) {
      const discountCheck = await checkCustomerDiscount(
        customerId, 
        productId, 
        quantity, 
        unitPrice
      );

      if (discountCheck.hasDiscount) {
        finalUnitPrice = discountCheck.finalPrice;
        discountAmount = discountCheck.discountAmount;
        discountPercentage = discountCheck.discountPercentage;
        applicableDiscount = discountCheck.discount;
      }
    }

    // Handle on-the-spot discount approval requests
    if (requestDiscountApproval && req.user.role === 'SUPER_ADMIN') {
      // Super admin can approve discounts immediately
      if (discountReason && customerId) {
        // Apply manual discount (requires justification)
        const manualDiscountPercent = parseFloat(req.body.manualDiscountPercent || 0);
        if (manualDiscountPercent > 0 && manualDiscountPercent <= 50) { // Max 50% discount
          originalUnitPrice = unitPrice;
          discountAmount = (unitPrice * manualDiscountPercent) / 100;
          finalUnitPrice = unitPrice - discountAmount;
          discountPercentage = manualDiscountPercent;
          requiresApproval = false; // Already approved by super admin
        }
      }
    } else if (requestDiscountApproval && customerId) {
      // Non-admin users must request approval
      requiresApproval = true;
      // Create pending discount request
      await prisma.discountApprovalRequest.create({
        data: {
          warehouseCustomerId: customerId,
          productId,
          requestedDiscountType: 'PERCENTAGE',
          requestedDiscountValue: parseFloat(req.body.requestedDiscountPercent || 5),
          minimumQuantity: quantity,
          validFrom: new Date(),
          validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
          reason: discountReason || 'Customer requested discount',
          businessJustification: `Requested during sale of ${quantity} ${unitType} of ${product.name}`,
          requestedBy: req.user.id
        }
      });
    }

    // Calculate final amounts
    const totalAmount = parseFloat((quantity * finalUnitPrice).toFixed(2));
    const totalDiscountAmount = parseFloat((quantity * discountAmount).toFixed(2));
    const costPerUnit = parseFloat(product.costPerPack || 0);
    const totalCost = parseFloat((quantity * costPerUnit).toFixed(2));
    const grossProfit = parseFloat((totalAmount - totalCost).toFixed(2));
    const profitMargin = totalAmount > 0 ? (grossProfit / totalAmount) * 100 : 0;

    const providedReceiptNumber = req.body.receiptNumber;
    const receiptNumber = providedReceiptNumber || await generateReceiptNumber();

    const createSaleOperation = () => prisma.$transaction(async (tx) => {
      // Create warehouse sale with discount tracking
      const warehouseSale = await tx.warehouseSale.create({
        data: {
          productId,
          quantity,
          unitType,
          unitPrice: finalUnitPrice,
          totalAmount,
          costPerUnit,
          totalCost,
          grossProfit,
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          paymentMethod,
          warehouseCustomerId: customerId,
          customerName: customerName, // Keep for backward compatibility
          customerPhone: customerPhone, // Keep for backward compatibility
          receiptNumber,
          salesOfficer: req.user.id,
          
          // NEW: Discount tracking
          originalUnitPrice: discountAmount > 0 ? originalUnitPrice : null,
          discountApplied: discountAmount > 0,
          totalDiscountAmount,
          discountPercentage: parseFloat(discountPercentage.toFixed(2)),
          discountReason: discountAmount > 0 ? (discountReason || 'Customer discount applied') : null,
          approvedBy: req.user.role === 'SUPER_ADMIN' && discountAmount > 0 ? req.user.id : null
        },
        include: {
          product: true,
          warehouseCustomer: true,
          salesOfficerUser: {
            select: { id: true, username: true }
          },
          discountApprover: {
            select: { username: true }
          }
        }
      });

      // If discount was applied, track it and update usage
      if (applicableDiscount && discountAmount > 0) {
        // Create sale discount record
        await tx.warehouseSaleDiscount.create({
          data: {
            warehouseSaleId: warehouseSale.id,
            customerDiscountId: applicableDiscount.id,
            originalUnitPrice,
            discountedUnitPrice: finalUnitPrice,
            discountAmountPerUnit: discountAmount,
            totalDiscountAmount,
            quantityApplied: quantity
          }
        });

        // Update discount usage
        await tx.warehouseCustomerDiscount.update({
          where: { id: applicableDiscount.id },
          data: {
            usageCount: { increment: 1 },
            totalDiscountGiven: { increment: totalDiscountAmount }
          }
        });
      }

      // Update inventory if tracking by packs
      if (unitType === 'PACKS') {
        await tx.warehouseInventory.updateMany({
          where: { productId },
          data: {
            packs: { decrement: quantity }
          }
        });
      }

      if (customerId) {
        const customerStats = await tx.warehouseCustomer.update({
          where: { id: customerId },
          data: {
            totalPurchases: { increment: 1 },
            totalSpent: { increment: totalAmount },
            lastPurchaseDate: new Date()
          },
          select: {
            totalPurchases: true,
            totalSpent: true
          }
        });

        const totalSpentValue = parseFloat(customerStats.totalSpent.toString());
        const averageOrderValue = customerStats.totalPurchases > 0
          ? parseFloat((totalSpentValue / customerStats.totalPurchases).toFixed(2))
          : 0;

        await tx.warehouseCustomer.update({
          where: { id: customerId },
          data: {
            averageOrderValue
          }
        });
      }

      return warehouseSale;
    });

    const sale = await withReceiptConflictRetry(() => createSaleOperation());

    const response = {
      success: true,
      message: 'Warehouse sale recorded successfully',
      data: { sale }
    };

    // Add discount approval message if applicable
    if (requiresApproval) {
      response.message = 'Sale recorded and discount approval request submitted';
      response.pendingApproval = true;
    }

    res.status(201).json(response);
  })
);

// Helper function to check customer discounts
async function checkCustomerDiscount(customerId, productId, quantity, unitPrice) {
  // ✅ Only check approved customer discounts
  const applicableDiscounts = await prisma.warehouseCustomerDiscount.findMany({
    where: {
      warehouseCustomerId: customerId,
      status: 'APPROVED', // ignore pending requests
      OR: [
        { productId },
        { productId: null }
      ],
      minimumQuantity: { lte: quantity },
      validFrom: { lte: new Date() },
      OR: [
        { validUntil: null },
        { validUntil: { gte: new Date() } }
      ],
    },
    include: {
      product: { select: { name: true } }
    },
    orderBy: [
      { productId: 'desc' },
      { discountValue: 'desc' }
    ]
  });

  if (applicableDiscounts.length === 0) {
    return {
      hasDiscount: false,
      originalPrice: unitPrice,
      finalPrice: unitPrice,
      discountAmount: 0,
      discountPercentage: 0
    };
  }

  // ✅ Apply best active discount
  const bestDiscount = applicableDiscounts[0];
  let discountAmount = 0;

  if (bestDiscount.discountType === 'PERCENTAGE') {
    discountAmount = (unitPrice * bestDiscount.discountValue) / 100;
    if (bestDiscount.maximumDiscountAmount && discountAmount > bestDiscount.maximumDiscountAmount) {
      discountAmount = bestDiscount.maximumDiscountAmount;
    }
  } else if (bestDiscount.discountType === 'FIXED_AMOUNT') {
    discountAmount = Math.min(bestDiscount.discountValue, unitPrice);
  }

  const discountedPrice = Math.max(0, unitPrice - discountAmount);

  return {
    hasDiscount: true,
    originalPrice: parseFloat(unitPrice.toFixed(2)),
    finalPrice: parseFloat(discountedPrice.toFixed(2)),
    discountAmount: parseFloat(discountAmount.toFixed(2)),
    discountPercentage: parseFloat(((discountAmount / unitPrice) * 100).toFixed(2)),
    discount: {
      id: bestDiscount.id,
      type: bestDiscount.discountType,
      value: bestDiscount.discountValue,
      reason: bestDiscount.reason
    }
  };
}


// @route   GET /api/v1/warehouse/sales/by-receipt/:receiptNumber
// @desc    Get all sale items grouped by receipt number
// @access  Private (Warehouse module access)
router.get('/sales/by-receipt/:receiptNumber',
  authorizeModule('warehouse'),
  param('receiptNumber').isString().trim().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { receiptNumber } = req.params;
    const where = { receiptNumber };

    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.salesOfficer = req.user.id;
    }

    const sales = await prisma.warehouseSale.findMany({
      where,
      include: {
        product: { select: { name: true, productNo: true } },
        warehouseCustomer: { select: { id: true, name: true, phone: true } },
        salesOfficerUser: { select: { id: true, username: true, role: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    if (sales.length === 0) {
      throw new NotFoundError('Sale not found');
    }

    const aggregatedSale = {
      receiptNumber,
      saleIds: [],
      warehouseCustomerId: sales[0].warehouseCustomerId,
      customerName: sales[0].customerName || sales[0].warehouseCustomer?.name || null,
      customerPhone: sales[0].customerPhone || sales[0].warehouseCustomer?.phone || null,
      paymentMethod: sales[0].paymentMethod,
      salesOfficer: sales[0].salesOfficer,
      salesOfficerUser: sales[0].salesOfficerUser,
      warehouseCustomer: sales[0].warehouseCustomer,
      discountApplied: false,
      totalAmount: 0,
      totalDiscountAmount: 0,
      totalCost: 0,
      grossProfit: 0,
      createdAt: sales[sales.length - 1].createdAt,
      items: []
    };

    for (const sale of sales) {
      aggregatedSale.saleIds.push(sale.id);
      aggregatedSale.totalAmount += Number(sale.totalAmount);
      aggregatedSale.totalDiscountAmount += Number(sale.totalDiscountAmount || 0);
      aggregatedSale.totalCost += Number(sale.totalCost || 0);
      aggregatedSale.grossProfit += Number(sale.grossProfit || 0);
      aggregatedSale.discountApplied = aggregatedSale.discountApplied || sale.discountApplied;

      if (!aggregatedSale.customerName) {
        aggregatedSale.customerName = sale.customerName || sale.warehouseCustomer?.name || null;
      }

      if (!aggregatedSale.customerPhone) {
        aggregatedSale.customerPhone = sale.customerPhone || sale.warehouseCustomer?.phone || null;
      }

      if (!aggregatedSale.warehouseCustomer && sale.warehouseCustomer) {
        aggregatedSale.warehouseCustomer = sale.warehouseCustomer;
      }

      aggregatedSale.items.push({
        id: sale.id,
        productId: sale.productId,
        product: sale.product,
        quantity: sale.quantity,
        unitType: sale.unitType,
        unitPrice: Number(sale.unitPrice),
        totalAmount: Number(sale.totalAmount),
        totalDiscountAmount: sale.totalDiscountAmount ? Number(sale.totalDiscountAmount) : 0,
        discountApplied: sale.discountApplied,
        discountPercentage: sale.discountPercentage ? Number(sale.discountPercentage) : null,
        originalUnitPrice: sale.originalUnitPrice ? Number(sale.originalUnitPrice) : null,
        costPerUnit: Number(sale.costPerUnit || 0),
        totalCost: Number(sale.totalCost || 0),
        grossProfit: Number(sale.grossProfit || 0)
      });
    }

    aggregatedSale.totalQuantity = aggregatedSale.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    aggregatedSale.itemsCount = aggregatedSale.items.length;

    res.json({
      success: true,
      data: { sale: aggregatedSale }
    });
  })
);

// @route   GET /api/v1/warehouse/sales/:id
// @desc    Get single warehouse sale
// @access  Private (Warehouse module access)
router.get('/sales/:id',
  param('id').custom(validateCuid('sale ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const where = { id };

    // Role-based access
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.salesOfficer = req.user.id;
    }

    const sale = await prisma.warehouseSale.findFirst({
      where,
      include: {
        product: true,
        salesOfficerUser: {
          select: { username: true, role: true }
        }
      }
    });

    if (!sale) {
      throw new NotFoundError('Sale not found');
    }

    res.json({
      success: true,
      data: { sale }
    });
  })
);

// ================================
// CASH FLOW ROUTES
// ================================

// @route   POST /api/v1/warehouse/cash-flow
// @desc    Create cash flow entry
// @access  Private (Cashier, Warehouse Admin)
router.post('/cash-flow',
  createCashFlowValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    // Only cashiers and warehouse admins
    if (!['CASHIER', 'WAREHOUSE_ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new BusinessError('Access denied', 'INSUFFICIENT_PERMISSIONS');
    }

    const {
      transactionType,
      amount,
      paymentMethod,
      description,
      referenceNumber
    } = req.body;

    const cashFlow = await prisma.cashFlow.create({
      data: {
        transactionType,
        amount: parseFloat(amount),
        paymentMethod,
        description,
        referenceNumber,
        cashier: req.user.id
      },
      include: {
        cashierUser: {
          select: { username: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Cash flow entry created successfully',
      data: { cashFlow }
    });
  })
);

// @route   GET /api/v1/warehouse/cash-flow
// @desc    Get cash flow entries with filtering
// @access  Private (Cashier, Warehouse Admin)
router.get('/cash-flow', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    transactionType,
    paymentMethod,
    startDate,
    endDate,
    isReconciled
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const where = {};

  if (transactionType) where.transactionType = transactionType;
  if (paymentMethod) where.paymentMethod = paymentMethod;
  
  if (isReconciled !== undefined) {
    where.isReconciled = isReconciled === 'true';
  }

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [entries, total] = await Promise.all([
    prisma.cashFlow.findMany({
      where,
      include: {
        cashierUser: {
          select: { username: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take
    }),
    prisma.cashFlow.count({ where })
  ]);

  res.json({
    success: true,
    data: {
      cashFlowEntries: entries,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

router.use('/', warehouseExpensesRouter);


// ================================
// ANALYTICS & REPORTS
// ================================

// @route   GET /api/v1/warehouse/analytics/summary
// @desc    Get warehouse analytics summary
// @access  Private (Warehouse module access)
router.get('/analytics/summary',
  authorizeModule('warehouse'),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    const sales = await prisma.warehouseSale.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined
      },
      include: { product: true }
    });

    // Calculate metrics
    let totalRevenue = 0;
    let totalCOGS = 0;
    let totalQuantitySold = 0;

    sales.forEach(sale => {
      totalRevenue += parseFloat(sale.totalAmount);
      totalCOGS += parseFloat(sale.totalCost);
      totalQuantitySold += sale.quantity;
    });

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
          totalSales: sales.length,
          totalQuantitySold
        },
        period: { startDate, endDate }
      }
    });
  })
);

// @route   GET /api/v1/warehouse/analytics/profit-summary
// @desc    Get detailed profit summary
// @access  Private (Warehouse Admin)
router.get('/analytics/profit-summary',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    
    const where = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const profitByProduct = await prisma.warehouseSale.groupBy({
      by: ['productId'],
      where,
      _sum: {
        totalAmount: true,
        totalCost: true,
        grossProfit: true,
        quantity: true
      },
      _avg: {
        profitMargin: true
      },
      _count: true,
      orderBy: {
        _sum: {
          grossProfit: 'desc'
        }
      }
    });

    // Get product details
    const productIds = profitByProduct.map(p => p.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, productNo: true }
    });

    const profitAnalysis = profitByProduct.map(item => ({
      product: products.find(p => p.id === item.productId),
      salesCount: item._count,
      totalQuantity: item._sum.quantity,
      revenue: parseFloat((item._sum.totalAmount || 0).toFixed(2)),
      cost: parseFloat((item._sum.totalCost || 0).toFixed(2)),
      profit: parseFloat((item._sum.grossProfit || 0).toFixed(2)),
      avgMargin: parseFloat((item._avg.profitMargin || 0).toFixed(2))
    }));

    const totals = profitAnalysis.reduce((acc, item) => ({
      revenue: acc.revenue + item.revenue,
      cost: acc.cost + item.cost,
      profit: acc.profit + item.profit
    }), { revenue: 0, cost: 0, profit: 0 });

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totals.revenue.toFixed(2)),
          totalCost: parseFloat(totals.cost.toFixed(2)),
          totalProfit: parseFloat(totals.profit.toFixed(2)),
          overallMargin: totals.revenue > 0 ? 
            parseFloat(((totals.profit / totals.revenue) * 100).toFixed(2)) : 0
        },
        profitByProduct: profitAnalysis
      }
    });
  })
);

module.exports = router;
