const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// MIDDLEWARE - Warehouse Module Access
// ================================

// All warehouse routes require warehouse module access
router.use(authorizeModule('warehouse'));

// ================================
// VALIDATION RULES
// ================================

const updateInventoryValidation = [
  body('packs')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Packs must be a non-negative integer'),
  body('units')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Units must be a non-negative integer'),
  body('reorderLevel')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Reorder level must be a non-negative integer'),
  body('maxStockLevel')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Max stock level must be a positive integer'),
  body('location')
    .optional()
    .isLength({ max: 100 })
    .withMessage('Location must not exceed 100 characters')
];

const createSaleValidation = [
  body('productId')
    .notEmpty()
    .withMessage('Product ID is required')
    .isUUID()
    .withMessage('Invalid product ID format'),
  body('quantity')
    .isInt({ min: 1 })
    .withMessage('Quantity must be a positive integer'),
  body('unitType')
    .isIn(['PACKS', 'UNITS'])
    .withMessage('Invalid unit type'),
  body('unitPrice')
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Unit price must be a valid decimal'),
  body('paymentMethod')
    .isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY'])
    .withMessage('Invalid payment method'),
  body('customerName')
    .optional()
    .isLength({ max: 100 })
    .withMessage('Customer name must not exceed 100 characters'),
  body('customerPhone')
    .optional()
    .isLength({ max: 20 })
    .withMessage('Customer phone must not exceed 20 characters')
];

const createCashFlowValidation = [
  body('transactionType')
    .isIn(['CASH_IN', 'CASH_OUT', 'SALE', 'EXPENSE', 'ADJUSTMENT'])
    .withMessage('Invalid transaction type'),
  body('amount')
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Amount must be a valid decimal'),
  body('paymentMethod')
    .isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY'])
    .withMessage('Invalid payment method'),
  body('description')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Description must not exceed 200 characters'),
  body('referenceNumber')
    .optional()
    .isLength({ max: 50 })
    .withMessage('Reference number must not exceed 50 characters')
];

// ================================
// UTILITY FUNCTIONS
// ================================

const generateReceiptNumber = async () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  
  // Find the last receipt number for today
  const lastSale = await prisma.warehouseSale.findFirst({
    where: {
      receiptNumber: {
        startsWith: `WH-${year}${month}${day}-`
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  let sequence = 1;
  if (lastSale) {
    const lastSequence = parseInt(lastSale.receiptNumber.split('-').pop());
    sequence = lastSequence + 1;
  }

  return `WH-${year}${month}${day}-${String(sequence).padStart(3, '0')}`;
};

const updateInventoryAfterSale = async (productId, quantity, unitType, tx = prisma) => {
  const inventory = await tx.warehouseInventory.findFirst({
    where: { productId }
  });

  if (!inventory) {
    throw new BusinessError('Product not found in inventory', 'INVENTORY_NOT_FOUND');
  }

  const updateData = {};
  
  switch (unitType) {
    case 'PACKS':
      if (inventory.packs < quantity) {
        throw new BusinessError('Insufficient packs in stock', 'INSUFFICIENT_STOCK');
      }
      updateData.packs = inventory.packs - quantity;
      break;
    case 'UNITS':
      if (inventory.units < quantity) {
        throw new BusinessError('Insufficient units in stock', 'INSUFFICIENT_STOCK');
      }
      updateData.units = inventory.units - quantity;
      break;
  }

  return await tx.warehouseInventory.update({
    where: { id: inventory.id },
    data: updateData
  });
};

// ================================
// ROUTES - INVENTORY MANAGEMENT
// ================================

// @route   GET /api/v1/warehouse/inventory
// @desc    Get warehouse inventory with filtering and pagination
// @access  Private (Warehouse module access)
router.get('/inventory', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    location,
    lowStock = false,
    search
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  // Build where clause
  const where = {};

  if (location) where.location = location;

  if (search) {
    where.product = {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { productNo: { contains: search, mode: 'insensitive' } }
      ]
    };
  }

  // Get inventory items
  let inventory = await prisma.warehouseInventory.findMany({
    where,
    include: {
      product: true
    },
    orderBy: [
      { product: { name: 'asc' } }
    ],
    skip,
    take
  });

  // Filter for low stock if requested
  if (lowStock === 'true') {
    inventory = inventory.filter(item => 
      item.packs <= item.reorderLevel
    );
  }

  const total = await prisma.warehouseInventory.count({ where });

  // Calculate total inventory value
  const inventoryWithValues = inventory.map(item => {
    const totalUnits = (item.packs * 1) + (item.units * 1);
    const totalValue = totalUnits * item.product.pricePerPack;
    
    return {
      ...item,
      totalUnits,
      totalValue: parseFloat(totalValue.toFixed(2)),
      isLowStock: item.packs <= item.reorderLevel
    };
  });

  res.json({
    success: true,
    data: {
      inventory: inventoryWithValues,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// @route   GET /api/v1/warehouse/inventory/:productId
// @desc    Get single product inventory
// @access  Private (Warehouse module access)
router.get('/inventory/:productId',
  param('productId').isUUID().withMessage('Invalid product ID'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { productId } = req.params;

    const inventory = await prisma.warehouseInventory.findFirst({
      where: { productId },
      include: {
        product: true
      }
    });

    if (!inventory) {
      throw new NotFoundError('Product not found in inventory');
    }

    // Calculate totals
    const totalUnits = inventory.packs + inventory.units;
    const totalValue = totalUnits * inventory.product.pricePerPack;

    const inventoryWithCalculations = {
      ...inventory,
      totalUnits,
      totalValue: parseFloat(totalValue.toFixed(2)),
      isLowStock: inventory.packs <= inventory.reorderLevel
    };

    res.json({
      success: true,
      data: { inventory: inventoryWithCalculations }
    });
  })
);

// @route   PUT /api/v1/warehouse/inventory/:id
// @desc    Update inventory levels
// @access  Private (Warehouse Admin, Warehouse Sales Officer)
router.put('/inventory/:id',
  param('id').isUUID().withMessage('Invalid inventory ID'),
  authorizeModule('warehouse', 'write'),
  updateInventoryValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;
    const userId = req.user.id;

    // Get existing inventory
    const existingInventory = await prisma.warehouseInventory.findUnique({
      where: { id },
      include: { product: true }
    });

    if (!existingInventory) {
      throw new NotFoundError('Inventory record not found');
    }

    // Update inventory
    const updatedInventory = await prisma.warehouseInventory.update({
      where: { id },
      data: updateData,
      include: {
        product: true
      }
    });

    // Log the change
    await logDataChange(
      userId,
      'warehouse_inventory',
      id,
      'UPDATE',
      existingInventory,
      updatedInventory,
      getClientIP(req)
    );

    res.json({
      success: true,
      message: 'Inventory updated successfully',
      data: { inventory: updatedInventory }
    });
  })
);

// ================================
// ROUTES - WAREHOUSE SALES
// ================================

// @route   POST /api/v1/warehouse/sales
// @desc    Create warehouse sale
// @access  Private (Warehouse Sales Officer)
router.post('/sales',
  authorizeModule('warehouse', 'write'),
  createSaleValidation,
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
      customerName,
      customerPhone
    } = req.body;

    const userId = req.user.id;

    // Calculate total amount
    const totalAmount = parseFloat((quantity * parseFloat(unitPrice)).toFixed(2));

    // Generate receipt number
    const receiptNumber = await generateReceiptNumber();

    // Create sale and update inventory in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Update inventory
      await updateInventoryAfterSale(productId, quantity, unitType, tx);

      // Create sale record
      const sale = await tx.warehouseSale.create({
        data: {
          productId,
          quantity,
          unitType,
          unitPrice: parseFloat(unitPrice),
          totalAmount,
          paymentMethod,
          customerName,
          customerPhone,
          receiptNumber,
          salesOfficer: userId
        },
        include: {
          salesOfficerUser: {
            select: { username: true }
          }
        }
      });

      // Create cash flow entry if payment method is cash
      if (paymentMethod === 'CASH') {
        await tx.cashFlow.create({
          data: {
            transactionType: 'CASH_IN',
            amount: totalAmount,
            paymentMethod,
            description: `Warehouse sale - Receipt ${receiptNumber}`,
            referenceNumber: receiptNumber,
            cashier: userId
          }
        });
      }

      return sale;
    });

    res.status(201).json({
      success: true,
      message: 'Sale recorded successfully',
      data: { sale: result }
    });
  })
);

// @route   GET /api/v1/warehouse/sales
// @desc    Get warehouse sales with filtering and pagination
// @access  Private (Warehouse module access)
router.get('/sales', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    paymentMethod,
    startDate,
    endDate,
    search
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  // Build where clause
  const where = {};

  // Role-based filtering - non-admins see only their own sales
  if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
    where.salesOfficer = req.user.id;
  }

  if (paymentMethod) where.paymentMethod = paymentMethod;

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  if (search) {
    where.OR = [
      { receiptNumber: { contains: search, mode: 'insensitive' } },
      { customerName: { contains: search, mode: 'insensitive' } },
      { customerPhone: { contains: search, mode: 'insensitive' } }
    ];
  }

  const [sales, total] = await Promise.all([
    prisma.warehouseSale.findMany({
      where,
      include: {
        salesOfficerUser: {
          select: { username: true, role: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take
    }),
    prisma.warehouseSale.count({ where })
  ]);

  res.json({
    success: true,
    data: {
      sales,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// @route   GET /api/v1/warehouse/sales/:id
// @desc    Get single warehouse sale
// @access  Private (Warehouse module access)
router.get('/sales/:id',
  param('id').isUUID().withMessage('Invalid sale ID'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const where = { id };

    // Role-based access - non-admins can only see their own sales
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.salesOfficer = req.user.id;
    }

    const sale = await prisma.warehouseSale.findFirst({
      where,
      include: {
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
// ROUTES - CASH FLOW
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

    // Only cashiers and warehouse admins can create cash flow entries
    if (!['CASHIER', 'WAREHOUSE_ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new BusinessError('Insufficient permissions for cash flow operations', 'ACCESS_DENIED');
    }

    const {
      transactionType,
      amount,
      paymentMethod,
      description,
      referenceNumber
    } = req.body;

    const userId = req.user.id;

    const cashFlowEntry = await prisma.cashFlow.create({
      data: {
        transactionType,
        amount: parseFloat(amount),
        paymentMethod,
        description,
        referenceNumber,
        cashier: userId
      },
      include: {
        cashierUser: {
          select: { username: true, role: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Cash flow entry created successfully',
      data: { cashFlowEntry }
    });
  })
);

// @route   GET /api/v1/warehouse/cash-flow
// @desc    Get cash flow entries with filtering and pagination
// @access  Private (Cashier, Warehouse Admin)
router.get('/cash-flow', asyncHandler(async (req, res) => {
  // Only cashiers and warehouse admins can view cash flow
  if (!['CASHIER', 'WAREHOUSE_ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
    throw new BusinessError('Insufficient permissions for cash flow operations', 'ACCESS_DENIED');
  }

  const {
    page = 1,
    limit = 20,
    transactionType,
    paymentMethod,
    startDate,
    endDate,
    reconciled
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  // Build where clause
  const where = {};

  if (transactionType) where.transactionType = transactionType;
  if (paymentMethod) where.paymentMethod = paymentMethod;
  if (reconciled !== undefined) where.isReconciled = reconciled === 'true';

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
          select: { username: true, role: true }
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

// ================================
// ROUTES - ANALYTICS & REPORTS
// ================================

// @route   GET /api/v1/warehouse/analytics/summary
// @desc    Get warehouse analytics summary
// @access  Private (Warehouse module access)
router.get('/analytics/summary', asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  
  const where = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [
    totalSales,
    totalRevenue,
    paymentMethodBreakdown,
    lowStockItems,
    topSellingProducts,
    cashFlowSummary
  ] = await Promise.all([
    prisma.warehouseSale.count({ where }),
    
    prisma.warehouseSale.aggregate({
      where,
      _sum: { totalAmount: true }
    }),

    prisma.warehouseSale.groupBy({
      by: ['paymentMethod'],
      where,
      _count: { paymentMethod: true },
      _sum: { totalAmount: true }
    }),

    prisma.warehouseInventory.findMany({
      where: {
        OR: [
          { packs: { lte: prisma.warehouseInventory.fields.reorderLevel } }
        ]
      },
      include: {
        product: true
      },
      take: 10
    }),

    prisma.warehouseSale.groupBy({
      by: ['productId'],
      where,
      _sum: { quantity: true, totalAmount: true },
      _count: { productId: true },
      orderBy: { _sum: { totalAmount: 'desc' } },
      take: 5
    }),

    prisma.cashFlow.groupBy({
      by: ['transactionType'],
      _sum: { amount: true },
      _count: { transactionType: true }
    })
  ]);

  res.json({
    success: true,
    data: {
      totalSales,
      totalRevenue: totalRevenue._sum.totalAmount || 0,
      paymentMethodBreakdown,
      lowStockItemsCount: lowStockItems.length,
      lowStockItems,
      topSellingProducts,
      cashFlowSummary
    }
  });
}));

module.exports = router;