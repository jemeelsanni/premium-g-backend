const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

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
    data: { inventory }
  });
}));

// @route   PUT /api/v1/warehouse/inventory/:id
// @desc    Update inventory levels
// @access  Private (Warehouse Admin)
router.put('/inventory/:id',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  param('id').custom(validateCuid('inventory ID')),
  updateInventoryValidation,
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

// ================================
// WAREHOUSE SALES ROUTES
// ================================

// @route   POST /api/v1/warehouse/sales
// @desc    Create warehouse sale with cost tracking and profit calculation
// @access  Private (Warehouse Sales Officer, Admin)
router.post('/sales',
  authorizeModule('warehouse', 'write'),
  createWarehouseSaleValidation,
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

    // Get product for cost calculation
    const product = await prisma.product.findUnique({
      where: { id: productId }
    });

    if (!product) {
      throw new NotFoundError('Product not found');
    }

    // Calculate cost per unit based on type
    let costPerUnit = 0;
    
    switch (unitType) {
      case 'PALLETS':
        costPerUnit = parseFloat(product.costPerPack) * product.packsPerPallet;
        break;
      case 'PACKS':
        costPerUnit = parseFloat(product.costPerPack);
        break;
      case 'UNITS':
        // Assuming 10 units per pack - adjust based on your business logic
        costPerUnit = parseFloat(product.costPerPack) / 10;
        break;
    }

    // Calculate totals
    const totalAmount = parseFloat((quantity * parseFloat(unitPrice)).toFixed(2));
    const totalCost = parseFloat((quantity * costPerUnit).toFixed(2));
    const grossProfit = parseFloat((totalAmount - totalCost).toFixed(2));
    const profitMargin = totalAmount > 0 ? parseFloat(((grossProfit / totalAmount) * 100).toFixed(2)) : 0;

    // Generate receipt number
    const receiptNumber = await generateReceiptNumber();

    // Create sale with transaction
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
          costPerUnit,
          totalCost,
          grossProfit,
          profitMargin,
          paymentMethod,
          customerName,
          customerPhone,
          receiptNumber,
          salesOfficer: userId
        },
        include: {
          product: true,
          salesOfficerUser: {
            select: { username: true }
          }
        }
      });

      // Create cash flow entry if payment is cash
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
      data: { 
        sale: result,
        profitSummary: {
          revenue: totalAmount,
          cost: totalCost,
          profit: grossProfit,
          margin: profitMargin
        }
      }
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

  const where = {};

  // Role-based filtering
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
        product: true,
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

// ================================
// ANALYTICS & REPORTS
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
    salesSummary,
    paymentMethodBreakdown,
    lowStockItems,
    topProducts,
    cashFlowSummary
  ] = await Promise.all([
    prisma.warehouseSale.count({ where }),
    
    prisma.warehouseSale.aggregate({
      where,
      _sum: { 
        totalAmount: true,
        totalCost: true,
        grossProfit: true
      },
      _avg: {
        profitMargin: true
      }
    }),

    prisma.warehouseSale.groupBy({
      by: ['paymentMethod'],
      where,
      _count: { paymentMethod: true },
      _sum: { totalAmount: true }
    }),

    prisma.warehouseInventory.findMany({
      where: {
        packs: { lte: 20 }
      },
      include: {
        product: true
      },
      take: 10
    }),

    prisma.warehouseSale.groupBy({
      by: ['productId'],
      where,
      _sum: { 
        quantity: true, 
        totalAmount: true,
        grossProfit: true
      },
      _count: { productId: true },
      orderBy: { _sum: { totalAmount: 'desc' } },
      take: 10
    }),

    prisma.cashFlow.groupBy({
      by: ['transactionType'],
      where,
      _sum: { amount: true },
      _count: { transactionType: true }
    })
  ]);

  // Get product details for top products
  const productIds = topProducts.map(p => p.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, name: true, productNo: true }
  });

  const topProductsWithDetails = topProducts.map(tp => ({
    ...tp,
    product: products.find(p => p.id === tp.productId)
  }));

  const totalRevenue = salesSummary._sum.totalAmount || 0;
  const totalCost = salesSummary._sum.totalCost || 0;
  const totalProfit = salesSummary._sum.grossProfit || 0;
  const avgMargin = salesSummary._avg.profitMargin || 0;

  res.json({
    success: true,
    data: {
      salesMetrics: {
        totalSales,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        totalCost: parseFloat(totalCost.toFixed(2)),
        totalProfit: parseFloat(totalProfit.toFixed(2)),
        averageMargin: parseFloat(avgMargin.toFixed(2)),
        overallMargin: totalRevenue > 0 ? 
          parseFloat(((totalProfit / totalRevenue) * 100).toFixed(2)) : 0
      },
      paymentMethodBreakdown,
      lowStockItems: {
        count: lowStockItems.length,
        items: lowStockItems
      },
      topProducts: topProductsWithDetails,
      cashFlow: cashFlowSummary
    }
  });
}));

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