const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { body, query, validationResult } = require('express-validator');
const { authorizeModule } = require('../middleware/auth');
const { asyncHandler, ValidationError } = require('../middleware/errorHandler');

const prisma = new PrismaClient();

// ================================
// GET ALL PRODUCT PURCHASES (with filters)
// ================================
router.get('/',
  authorizeModule('warehouse', 'read'),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('productId').optional().isString(),
    query('vendorName').optional().isString(),
    query('paymentStatus').optional().isIn(['PAID', 'PARTIAL', 'PENDING']),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const {
      startDate,
      endDate,
      productId,
      vendorName,
      paymentStatus,
      page = 1,
      limit = 20
    } = req.query;

    // Build filter object
    const where = {};
    
    if (startDate || endDate) {
      where.purchaseDate = {};
      if (startDate) where.purchaseDate.gte = new Date(startDate);
      if (endDate) where.purchaseDate.lte = new Date(endDate);
    }
    
    if (productId) where.productId = productId;
    if (vendorName) where.vendorName = { contains: vendorName, mode: 'insensitive' };
    if (paymentStatus) where.paymentStatus = paymentStatus;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [purchases, total] = await Promise.all([
      prisma.warehouseProductPurchase.findMany({
        where,
        skip,
        take: parseInt(limit),
        include: {
          product: {
            select: {
              id: true,
              name: true,
              productNo: true,
              packsPerPallet: true
            }
          },
          createdByUser: {
            select: {
              id: true,
              username: true,
              fullName: true
            }
          }
        },
        orderBy: { purchaseDate: 'desc' }
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
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  })
);

// ================================
// CREATE PRODUCT PURCHASE
// ================================
router.post('/',
  authorizeModule('warehouse', 'write'),
  [
    body('productId').notEmpty().withMessage('Product ID is required'),
    body('vendorName').trim().notEmpty().withMessage('Vendor name is required'),
    body('vendorPhone').optional().trim(),
    body('vendorEmail').optional().isEmail(),
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

    // Create purchase and update inventory in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create purchase record
      const purchase = await tx.warehouseProductPurchase.create({
        data: {
          productId,
          vendorName,
          vendorPhone,
          vendorEmail,
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
          product: true,
          createdByUser: {
            select: {
              id: true,
              username: true,
              fullName: true
            }
          }
        }
      });

      // Update inventory based on unit type
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { packsPerPallet: true }
      });

      let inventory = await tx.warehouseInventory.findFirst({
        where: { productId }
      });

      if (!inventory) {
        // Create new inventory record
        inventory = await tx.warehouseInventory.create({
          data: {
            productId,
            pallets: 0,
            packs: 0,
            units: 0
          }
        });
      }

      // Calculate inventory updates
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

      // Update inventory
      await tx.warehouseInventory.update({
        where: { id: inventory.id },
        data: updates
      });

      return purchase;
    });

    res.status(201).json({
      success: true,
      message: 'Product purchase recorded and inventory updated',
      data: result
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
          totalCost: true,
          quantity: true
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
          amountDue: true
        },
        _count: true
      })
    ]);

    // Enrich product data
    const productIds = byProduct.map(p => p.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, productNo: true }
    });

    const productMap = products.reduce((acc, p) => {
      acc[p.id] = p;
      return acc;
    }, {});

    const enrichedProducts = byProduct.map(p => ({
      ...p,
      product: productMap[p.productId]
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
        topProducts: enrichedProducts,
        topVendors: byVendor,
        paymentStatusBreakdown: byPaymentStatus
      }
    });
  })
);

module.exports = router;