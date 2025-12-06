// routes/warehouse-customers.js - Warehouse customer management

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// WAREHOUSE CUSTOMER ROUTES
// ================================

// Create warehouse customer
router.post('/customers',
  authorizeModule('warehouse', 'write'),
  [
    body('name').trim().notEmpty().withMessage('Customer name is required'),
    body('email').optional().isEmail().withMessage('Valid email is required'),
    body('phone').optional().trim(),
    body('address').optional().trim(),
    body('customerType').optional().isIn(['INDIVIDUAL', 'BUSINESS', 'RETAILER']),
    body('businessName').optional().trim(),
    body('creditLimit').optional().isFloat({ min: 0 }),
    body('preferredPaymentMethod').optional().isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY'])
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const customerData = {
      ...req.body,
      createdBy: req.user.id
    };

    const customer = await prisma.warehouseCustomer.create({
      data: customerData,
      include: {
        createdByUser: { select: { id: true, username: true } }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Warehouse customer created successfully',
      data: { customer }
    });
  })
);

// Get warehouse customers
router.get('/customers',
  authorizeModule('warehouse', 'read'),
  [
    query('sortBy').optional().isIn([
      'name', 'recent', 'topSpender', 'topPurchases', 'creditScore'
    ]),
    query('customerType').optional().isIn(['INDIVIDUAL', 'BUSINESS', 'RETAILER']),
    query('hasOutstandingDebt').optional().isBoolean(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('filterMonth').optional().isInt({ min: 1, max: 12 }), // ✅ NEW
    query('filterYear').optional().isInt({ min: 2020 }),        // ✅ NEW
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 })
  ],
  asyncHandler(async (req, res) => {
    const {
      sortBy = 'topPurchases',  // ✅ CHANGED: Default to highest purchases
      customerType,
      hasOutstandingDebt,
      startDate,
      endDate,
      filterMonth,    // ✅ NEW
      filterYear,     // ✅ NEW
      page = 1,
      limit = 20
    } = req.query;

    const where = {};
    if (customerType) where.customerType = customerType;
    if (hasOutstandingDebt === 'true') {
      where.outstandingDebt = { gt: 0 };
    }

    // ✅ NEW: Enhanced date filtering with month/year support
    if (filterMonth && filterYear) {
      // Filter by specific month and year
      const year = parseInt(filterYear);
      const month = parseInt(filterMonth);
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

      where.OR = [
        {
          createdAt: {
            gte: startOfMonth,
            lte: endOfMonth
          }
        },
        {
          lastPurchaseDate: {
            gte: startOfMonth,
            lte: endOfMonth
          }
        }
      ];
    } else if (filterYear && !filterMonth) {
      // Filter by entire year
      const year = parseInt(filterYear);
      const startOfYear = new Date(year, 0, 1);
      const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);

      where.OR = [
        {
          createdAt: {
            gte: startOfYear,
            lte: endOfYear
          }
        },
        {
          lastPurchaseDate: {
            gte: startOfYear,
            lte: endOfYear
          }
        }
      ];
    } else if (startDate || endDate) {
      // Custom date range filter
      where.OR = [
        {
          createdAt: {
            ...(startDate && { gte: new Date(startDate) }),
            ...(endDate && { lte: new Date(endDate) })
          }
        },
        {
          lastPurchaseDate: {
            ...(startDate && { gte: new Date(startDate) }),
            ...(endDate && { lte: new Date(endDate) })
          }
        }
      ];
    }

    // Dynamic sorting - default to topPurchases
    let orderBy = {};
    switch (sortBy) {
      case 'recent':
        orderBy = { lastPurchaseDate: 'desc' };
        break;
      case 'topSpender':
        orderBy = { totalSpent: 'desc' };
        break;
      case 'topPurchases':
        orderBy = { totalPurchases: 'desc' };
        break;
      case 'creditScore':
        orderBy = { paymentReliabilityScore: 'desc' };
        break;
      case 'name':
        orderBy = { name: 'asc' };
        break;
      default:
        orderBy = { totalPurchases: 'desc' }; // ✅ Default sorting
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [customers, total, analytics] = await Promise.all([
      prisma.warehouseCustomer.findMany({
        where,
        skip,
        take: parseInt(limit),
        orderBy,
        include: {
          _count: {
            select: {
              sales: true,
              debtors: true
            }
          },
          sales: {
            select: {
              grossProfit: true
            }
          }
        }
      }),

      prisma.warehouseCustomer.count({ where }),

      prisma.warehouseCustomer.aggregate({
        where,
        _count: true,
        _sum: {
          totalSpent: true,
          totalPurchases: true,
          outstandingDebt: true
        },
        _avg: {
          averageOrderValue: true,
          paymentReliabilityScore: true
        }
      })
    ]);

    // Identify VIP customers (top 20% by spending)
    const topCustomers = await prisma.warehouseCustomer.findMany({
      where,
      orderBy: { totalSpent: 'desc' },
      take: Math.ceil(total * 0.2) || 1,
      select: { id: true }
    });

    const vipIds = topCustomers.map(c => c.id);

    // Mark recent customers (purchased in last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const enrichedCustomers = customers.map(customer => {
      // Calculate total profit from sales
      const totalProfit = customer.sales.reduce((sum, sale) => {
        return sum + (parseFloat(sale.grossProfit) || 0);
      }, 0);

      return {
        ...customer,
        totalProfit,
        isVIP: vipIds.includes(customer.id),
        isRecent: customer.lastPurchaseDate &&
                  customer.lastPurchaseDate >= thirtyDaysAgo,
        hasDebt: parseFloat(customer.outstandingDebt || 0) > 0,
        debtCount: customer._count.debtors
      };
    });

    res.json({
      success: true,
      data: {
        customers: enrichedCustomers,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        },
        analytics: {
          totalCustomers: analytics._count,
          totalRevenue: analytics._sum.totalSpent || 0,
          totalPurchases: analytics._sum.totalPurchases || 0,
          totalOutstandingDebt: analytics._sum.outstandingDebt || 0,
          averageOrderValue: analytics._avg.averageOrderValue || 0,
          averageCreditScore: analytics._avg.paymentReliabilityScore || 0
        }
      }
    });
  })
);

router.get('/customers/:id',
  authorizeModule('warehouse', 'read'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const customer = await prisma.warehouseCustomer.findUnique({
      where: { id },
      include: {
        sales: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: {
            product: {
              select: {
                name: true,
                productNo: true
              }
            }
          }
        },
        debtors: {
          where: {
            status: { in: ['OUTSTANDING', 'PARTIAL', 'OVERDUE'] }
          },
          include: {
            sale: {
              select: {
                receiptNumber: true,
                totalAmount: true
              }
            }
          }
        }
      }
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }

    // Get top products using Prisma (avoids BigInt)
    const topProducts = await prisma.warehouseSale.groupBy({
      by: ['productId'],
      where: { warehouseCustomerId: id },
      _sum: {
        quantity: true,
        totalAmount: true
      },
      _count: true,
      _avg: {
        unitPrice: true
      },
      orderBy: {
        _sum: {
          totalAmount: 'desc'
        }
      },
      take: 5
    });

    // Fetch product details
    const productIds = topProducts.map(p => p.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, productNo: true }
    });

    const productsMap = products.reduce((acc, p) => {
      acc[p.id] = p;
      return acc;
    }, {});

    const enrichedTopProducts = topProducts.map(item => ({
      product: productsMap[item.productId],
      purchaseCount: item._count,
      totalQuantity: Number(item._sum.quantity || 0),
      totalSpent: Number(item._sum.totalAmount || 0),
      avgPrice: Number(item._avg.unitPrice || 0)
    }));

    res.json({
      success: true,
      data: {
        customer,
        insights: {
          topProducts: enrichedTopProducts,
          debtSummary: {
            activeDebts: customer.debtors.length,
            totalOutstanding: customer.debtors.reduce(
              (sum, d) => sum + parseFloat(d.amountDue || 0),
              0
            )
          }
        }
      }
    });
  })
);

// Get warehouse customer purchase history
router.get('/customers/:id/purchases',
  authorizeModule('warehouse'),
  param('id').custom(validateCuid('customer ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { page = 1, limit = 10, startDate, endDate } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = { warehouseCustomerId: id };
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [sales, total, customer] = await Promise.all([
      prisma.warehouseSale.findMany({
        where,
        include: {
          product: { select: { name: true, productNo: true } },
          salesOfficerUser: { select: { username: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      prisma.warehouseSale.count({ where }),
      prisma.warehouseCustomer.findUnique({
        where: { id },
        select: { 
          name: true, 
          totalPurchases: true, 
          totalSpent: true, 
          averageOrderValue: true,
          lastPurchaseDate: true
        }
      })
    ]);

    if (!customer) {
      throw new NotFoundError('Customer not found');
    }

    res.json({
      success: true,
      data: {
        customer,
        purchases: sales,
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

// Update warehouse customer
router.put('/customers/:id',
  authorizeModule('warehouse', 'write'),
  param('id').custom(validateCuid('customer ID')),
  [
    body('name').optional().trim(),
    body('email').optional().isEmail(),
    body('phone').optional().trim(),
    body('address').optional().trim(),
    body('customerType').optional().isIn(['INDIVIDUAL', 'BUSINESS', 'RETAILER']),
    body('businessName').optional().trim(),
    body('creditLimit').optional().isFloat({ min: 0 }),
    body('preferredPaymentMethod').optional().isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
    body('isActive').optional().isBoolean()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;

    const customer = await prisma.warehouseCustomer.update({
      where: { id },
      data: updateData,
      include: {
        createdByUser: { select: { username: true } }
      }
    });

    res.json({
      success: true,
      message: 'Customer updated successfully',
      data: { customer }
    });
  })
);

module.exports = router;
