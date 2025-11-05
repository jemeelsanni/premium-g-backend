const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule } = require('../middleware/auth');

// ================================
// CREATE WAREHOUSE PURCHASE
// ================================
router.post('/',
  authorizeModule('warehouse', 'write'),
  [
    body('productId').notEmpty().withMessage('Product ID is required'),
    body('vendorName').trim().notEmpty().withMessage('Vendor name is required'),
    body('vendorPhone').optional().trim(),
    body('vendorEmail').optional().isEmail(),
    body('orderNumber').optional().trim(),
    body('batchNumber').optional().trim(),
    body('expiryDate').optional().isISO8601(),
    body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('unitType').isIn(['PALLETS', 'PACKS', 'UNITS']),
    body('costPerUnit').isFloat({ min: 0 }).withMessage('Cost must be positive'),
    body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
    body('paymentStatus').optional().isIn(['PAID', 'PARTIAL', 'PENDING']),
    body('amountPaid').optional().isFloat({ min: 0 }),
    body('purchaseDate').isISO8601(),
    body('invoiceNumber').optional().trim(),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      productId,
      vendorName,
      vendorPhone,
      vendorEmail,
      orderNumber,
      batchNumber,
      expiryDate,
      quantity,
      unitType,
      costPerUnit,
      paymentMethod,
      paymentStatus = 'PAID',
      amountPaid,
      purchaseDate,
      invoiceNumber,
      notes
    } = req.body;

    // Calculate total cost
    const totalCost = parseFloat(costPerUnit) * parseInt(quantity);
    const paidAmount = amountPaid ? parseFloat(amountPaid) : (paymentStatus === 'PAID' ? totalCost : 0);
    const dueAmount = totalCost - paidAmount;

    // Check expiry date (alert if within 30 days)
    let expiryAlert = null;
    if (expiryDate) {
      const expiry = new Date(expiryDate);
      const today = new Date();
      const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
      
      if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
        expiryAlert = {
          message: `Warning: Product expires in ${daysUntilExpiry} days`,
          daysRemaining: daysUntilExpiry,
          expiryDate: expiry.toISOString()
        };
      } else if (daysUntilExpiry <= 0) {
        throw new BusinessError('Cannot purchase expired products', 'EXPIRED_PRODUCT');
      }
    }

    // Use transaction to ensure atomic operations
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create purchase record
      const purchase = await tx.warehouseProductPurchase.create({
        data: {
          productId,
          vendorName,
          vendorPhone,
          vendorEmail,
          orderNumber,
          batchNumber,
          expiryDate: expiryDate ? new Date(expiryDate) : null,
          quantity: parseInt(quantity),
          unitType,
          costPerUnit: parseFloat(costPerUnit),
          totalCost,
          paymentMethod,
          paymentStatus,
          amountPaid: paidAmount,
          amountDue: dueAmount,
          purchaseDate: new Date(purchaseDate),
          invoiceNumber,
          notes,
          createdBy: req.user.id
        },
        include: {
          product: {
            select: { name: true, productNo: true }
          },
          createdByUser: {
            select: { username: true, role: true }
          }
        }
      });

      // 2. Find or create inventory record
      let inventory = await tx.warehouseInventory.findFirst({
        where: { productId }
      });

      if (!inventory) {
        inventory = await tx.warehouseInventory.create({
          data: {
            productId,
            pallets: 0,
            packs: 0,
            units: 0,
            reorderLevel: 10
          }
        });
      }

      // Update inventory based on unit type
      const updates = {
        pallets: inventory.pallets,
        packs: inventory.packs,
        units: inventory.units
      };

      if (unitType === 'PALLETS') {
        updates.pallets += parseInt(quantity);
      } else if (unitType === 'PACKS') {
        updates.packs += parseInt(quantity);
      } else if (unitType === 'UNITS') {
        updates.units += parseInt(quantity);
      }

      await tx.warehouseInventory.update({
        where: { id: inventory.id },
        data: updates
      });

      // 3. ✨ CREATE CASH FLOW ENTRY (ONLY FOR PAID/PARTIAL PAYMENTS) ✨
      let cashFlowEntry = null;
      
      if (paymentStatus === 'PAID' || paymentStatus === 'PARTIAL') {
        const cashFlowDescription = `Purchase: ${purchase.product.name} (${quantity} ${unitType}) from ${vendorName}`;
        
        cashFlowEntry = await tx.cashFlow.create({
          data: {
            transactionType: 'CASH_OUT',
            amount: paidAmount,
            paymentMethod: paymentMethod,
            description: cashFlowDescription,
            referenceNumber: invoiceNumber || orderNumber || `PUR-${purchase.id.slice(-8)}`,
            cashier: req.user.id,
            module: 'WAREHOUSE'
          }
        });
        
        console.log('✅ Cash flow entry created for purchase:', {
          transactionType: 'CASH_OUT',
          amount: paidAmount,
          paymentMethod,
          purchaseId: purchase.id
        });
      }

      return { purchase, inventory: updates, expiryAlert, cashFlowEntry };
    });

    const responseData = {
      success: true,
      message: 'Product purchase recorded, inventory updated, and cash flow tracked',
      data: result.purchase,
      cashFlowRecorded: result.cashFlowEntry !== null
    };

    if (result.expiryAlert) {
      responseData.warning = result.expiryAlert;
    }

    res.status(201).json(responseData);
  })
);

// ================================
// GET ALL PURCHASES
// ================================
router.get('/',
  authorizeModule('warehouse', 'read'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('productId').optional(),
    query('vendorName').optional().trim(),
    query('paymentStatus').optional().isIn(['PAID', 'PARTIAL', 'PENDING']),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const {
      page = 1,
      limit = 20,
      productId,
      vendorName,
      paymentStatus,
      startDate,
      endDate
    } = req.query;

    const where = {};

    if (productId) where.productId = productId;
    if (vendorName) where.vendorName = { contains: vendorName, mode: 'insensitive' };
    if (paymentStatus) where.paymentStatus = paymentStatus;

    if (startDate || endDate) {
      where.purchaseDate = {};
      if (startDate) where.purchaseDate.gte = new Date(startDate);
      if (endDate) where.purchaseDate.lte = new Date(endDate);
    }

    const [purchases, total] = await Promise.all([
      prisma.warehouseProductPurchase.findMany({
        where,
        include: {
          product: {
            select: { name: true, productNo: true }
          },
          createdByUser: {
            select: { username: true }
          }
        },  // ← Make sure this closing bracket exists
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit)
      }),
      prisma.warehouseProductPurchase.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        purchases,
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

// ================================
// GET EXPIRING PRODUCTS (within 30 days)
// ================================
router.get('/expiring',
  authorizeModule('warehouse', 'read'),
  asyncHandler(async (req, res) => {
    const today = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(today.getDate() + 30);

    const expiringPurchases = await prisma.warehouseProductPurchase.findMany({
      where: {
        expiryDate: {
          gte: today,
          lte: thirtyDaysFromNow
        }
      },
      include: {
        product: {
          select: { name: true, productNo: true }
        }
      },
      orderBy: { expiryDate: 'asc' }
    });

    // Calculate days until expiry for each
    const purchasesWithDays = expiringPurchases.map(purchase => {
      const daysUntilExpiry = Math.ceil(
        (new Date(purchase.expiryDate) - today) / (1000 * 60 * 60 * 24)
      );

      return {
        ...purchase,
        daysUntilExpiry,
        urgency: daysUntilExpiry <= 7 ? 'critical' : daysUntilExpiry <= 14 ? 'high' : 'medium'
      };
    });

    res.json({
      success: true,
      data: {
        expiringPurchases: purchasesWithDays,
        count: purchasesWithDays.length
      }
    });
  })
);

// ================================
// GET PURCHASE ANALYTICS
// ================================
router.get('/analytics',
  authorizeModule('warehouse', 'read'),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    const where = {};
    if (startDate || endDate) {
      where.purchaseDate = {};
      if (startDate) where.purchaseDate.gte = new Date(startDate);
      if (endDate) where.purchaseDate.lte = new Date(endDate);
    }

    const [summary, byProduct, byVendor, byPaymentStatus] = await Promise.all([
      // Overall summary
      prisma.warehouseProductPurchase.aggregate({
        where,
        _sum: {
          totalCost: true,
          amountPaid: true,
          amountDue: true
        },
        _count: true
      }),

      // Top products purchased
      prisma.warehouseProductPurchase.groupBy({
        by: ['productId'],
        where,
        _sum: {
          quantity: true,
          totalCost: true
        },
        _count: true,
        orderBy: {
          _sum: {
            totalCost: 'desc'
          }
        },
        take: 10
      }),

      // Top vendors
      prisma.warehouseProductPurchase.groupBy({
        by: ['vendorName'],
        where,
        _sum: {
          totalCost: true
        },
        _count: true,
        orderBy: {
          _sum: {
            totalCost: 'desc'
          }
        },
        take: 10
      }),

      // Payment status breakdown
      prisma.warehouseProductPurchase.groupBy({
        by: ['paymentStatus'],
        where,
        _sum: {
          totalCost: true,
          amountPaid: true,
          amountDue: true
        },
        _count: true
      })
    ]);

    // Fetch product details for top products
    const productIds = byProduct.map(p => p.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, productNo: true }
    });

    const productsMap = products.reduce((acc, p) => {
      acc[p.id] = p;
      return acc;
    }, {});

    const topProducts = byProduct.map(item => ({
      product: productsMap[item.productId],
      totalQuantity: item._sum.quantity,
      totalCost: item._sum.totalCost,
      purchaseCount: item._count
    }));

    res.json({
      success: true,
      data: {
        summary: {
          totalPurchases: summary._count,
          totalCost: summary._sum.totalCost || 0,
          totalPaid: summary._sum.amountPaid || 0,
          totalDue: summary._sum.amountDue || 0
        },
        topProducts,
        topVendors: byVendor.map(v => ({
          vendorName: v.vendorName,
          totalSpent: v._sum.totalCost,
          purchaseCount: v._count
        })),
        paymentBreakdown: byPaymentStatus
      }
    });
  })
);

// ================================
// GET SINGLE PURCHASE
// ================================
router.get('/:id',
  authorizeModule('warehouse', 'read'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const purchase = await prisma.warehouseProductPurchase.findUnique({
      where: { id },
      include: {
        product: true,
        createdByUser: {
          select: { username: true, role: true }
        }
      }
    });

    if (!purchase) {
      throw new NotFoundError('Purchase not found');
    }

    res.json({
      success: true,
      data: { purchase }
    });
  })
);

module.exports = router;