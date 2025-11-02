// routes/analytics/warehouse.js - Warehouse-only analytics

const express = require('express');
const { query, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError } = require('../../middleware/errorHandler');
const { authorizeModule } = require('../../middleware/auth');
const { authorizeRole } = require('../../middleware/auth'); // Import authorizeRole

const router = express.Router();
const prisma = new PrismaClient();

// GET /api/v1/analytics/warehouse/summary
router.get('/summary',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_SALES_OFFICER']),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('filterMonth').optional().isInt({ min: 1, max: 12 }),
    query('filterYear').optional().isInt({ min: 2020 }),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { startDate, endDate, filterMonth, filterYear } = req.query;

    // Default to current month if no filters provided
    const now = new Date();
    let dateFilter = {};

    if (filterMonth && filterYear) {
      // Filter by specific month and year
      const year = parseInt(filterYear);
      const month = parseInt(filterMonth);
      const startOfMonth = new Date(year, month - 1, 1);
      const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);
      
      dateFilter = {
        gte: startOfMonth,
        lte: endOfMonth
      };
    } else if (filterYear && !filterMonth) {
      // Filter by entire year
      const year = parseInt(filterYear);
      const startOfYear = new Date(year, 0, 1);
      const endOfYear = new Date(year, 11, 31, 23, 59, 59, 999);
      
      dateFilter = {
        gte: startOfYear,
        lte: endOfYear
      };
    } else if (startDate || endDate) {
      // Custom date range
      if (startDate) dateFilter.gte = new Date(startDate);
      if (endDate) dateFilter.lte = new Date(endDate);
    } else {
      // DEFAULT: Current month only (auto-reset on first day of month)
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      
      dateFilter = {
        gte: startOfMonth,
        lte: endOfMonth
      };
    }

    // Fetch data with date filter
    const [sales, cashFlow, inventory, customers] = await Promise.all([
  prisma.warehouseSale.findMany({
    where: {
      createdAt: { ...dateFilter }   // ✅ wrap it properly
    },
    include: {
      product: { select: { name: true, productNo: true } }
    }
  }),

  prisma.cashFlow.findMany({
    where: {
      createdAt: { ...dateFilter }   // ✅ wrap properly
    }
  }),

  prisma.warehouseInventory.findMany({
    include: {
      product: { select: { name: true, productNo: true, packsPerPallet: true, pricePerPack: true } }
    }
  }),

  prisma.warehouseCustomer.findMany({
    where: {
      isActive: true,
      OR: [
        { lastPurchaseDate: { ...dateFilter } },
        { warehouseSales: { some: { createdAt: { ...dateFilter } } } }
      ]
    },
    select: { id: true, isActive: true }
  })
]);


    // Calculate sales metrics
    let totalRevenue = 0;
    let totalCOGS = 0;
    let totalQuantitySold = 0;
    const productStats = {};
    const dailySales = {};

    sales.forEach(sale => {
      const revenue = parseFloat(sale.totalAmount);
      const cost = parseFloat(sale.totalCost);
      
      totalRevenue += revenue;
      totalCOGS += cost;
      totalQuantitySold += sale.quantity;

      // Product statistics
      const productName = sale.product?.name || 'Unknown Product';
      if (!productStats[productName]) {
        productStats[productName] = { 
          sales: 0, 
          revenue: 0, 
          quantity: 0, 
          profit: 0 
        };
      }
      productStats[productName].sales += 1;
      productStats[productName].revenue += revenue;
      productStats[productName].quantity += sale.quantity;
      productStats[productName].profit += parseFloat(sale.grossProfit);

      // Daily sales tracking
      const saleDate = sale.createdAt.toISOString().split('T')[0];
      if (!dailySales[saleDate]) {
        dailySales[saleDate] = { sales: 0, revenue: 0 };
      }
      dailySales[saleDate].sales += 1;
      dailySales[saleDate].revenue += revenue;
    });

    // Calculate cash flow metrics
    let totalCashIn = 0;
    let totalCashOut = 0;
    
    cashFlow.forEach(entry => {
      if (entry.transactionType === 'CASH_IN' || entry.transactionType === 'SALE') {
        totalCashIn += parseFloat(entry.amount);
      } else {
        totalCashOut += parseFloat(entry.amount);
      }
    });

    // Calculate inventory metrics
    let totalStockValue = 0;
    let lowStockItems = 0;
    let outOfStockItems = 0;

    inventory.forEach(item => {
      const stockLevel = item.packs + (item.pallets * (item.product?.packsPerPallet || 1));
      totalStockValue += stockLevel * parseFloat(item.product?.pricePerPack || 0);
      
      if (stockLevel === 0) {
        outOfStockItems++;
      } else if (stockLevel <= item.reorderLevel) {
        lowStockItems++;
      }
    });

    const grossProfit = totalRevenue - totalCOGS;
    const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const averageSaleValue = sales.length > 0 ? totalRevenue / sales.length : 0;
    const netCashFlow = totalCashIn - totalCashOut;

    const totalCustomers = await prisma.warehouseCustomer.count();
    const activeCustomers = customers.length; // Active customers in the filtered period

    const topProducts = Object.entries(productStats)
      .map(([name, stats]) => ({ productName: name, ...stats }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    const dailyPerformance = Object.entries(dailySales)
      .map(([date, stats]) => ({ date, ...stats }))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 7);

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalCOGS: parseFloat(totalCOGS.toFixed(2)),
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          totalSales: sales.length,
          totalQuantitySold,
          averageSaleValue: parseFloat(averageSaleValue.toFixed(2)),
          totalCustomers,
          activeCustomers
        },
        
        cashFlow: {
          totalCashIn: parseFloat(totalCashIn.toFixed(2)),
          totalCashOut: parseFloat(totalCashOut.toFixed(2)),
          netCashFlow: parseFloat(netCashFlow.toFixed(2))
        },
        
        inventory: {
          totalStockValue: parseFloat(totalStockValue.toFixed(2)),
          totalItems: inventory.length,
          lowStockItems,
          outOfStockItems,
          stockHealthPercentage: inventory.length > 0 ?
            ((inventory.length - lowStockItems - outOfStockItems) / inventory.length) * 100 : 0
        },

        customerSummary: {
          totalCustomers,
          activeCustomers
        },
        
        topProducts,
        dailyPerformance,
        period: { 
          startDate: dateFilter.gte?.toISOString(), 
          endDate: dateFilter.lte?.toISOString(),
          filterMonth,
          filterYear 
        }
      }
    });
  })
);


router.get('/dashboard',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_SALES_OFFICER']),
  asyncHandler(async (req, res) => {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      const todaySales = await prisma.warehouseSale.findMany({
        where: {
          createdAt: { gte: startOfDay, lte: endOfDay }
        },
        include: { product: true }
      });

      const dailySales = todaySales.length;
      const dailyRevenue = todaySales.reduce((sum, sale) => sum + sale.totalAmount, 0);

      const lowStockItems = await prisma.warehouseInventory.findMany({
        where: {
          OR: [
            { pallets: { lte: 5 } },
            { packs: { lte: 10 } },
            { units: { lte: 50 } }
          ]
        }
      });

      res.json({
        success: true,
        data: {
          dailySales,
          dailyRevenue,
          lowStockItems: lowStockItems.length,
          totalCustomers: 0,
          recentSales: todaySales.slice(0, 10).map(sale => ({
            id: sale.id,
            productName: sale.product?.name || 'Unknown Product',
            quantity: sale.quantity,
            unitType: sale.unitType,
            totalAmount: sale.totalAmount,
            customerName: sale.customerName || 'Walk-in Customer',
            createdAt: sale.createdAt
          }))
        }
      });
    } catch (error) {
      console.error('Warehouse dashboard error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to fetch warehouse dashboard data'
      });
    }
  })
);

// Get inventory status
router.get('/inventory/status',
  authorizeModule('warehouse'),
  asyncHandler(async (req, res) => {
    const inventory = await prisma.warehouseInventory.findMany({
      include: {
        product: {
          select: { 
            name: true, 
            productNo: true, 
            pricePerPack: true,
            packsPerPallet: true 
          }
        }
      }
    });

    const categorizedInventory = {
      inStock: [],
      lowStock: [],
      outOfStock: [],
      overStock: []
    };

    inventory.forEach(item => {
      const totalPacks = item.packs + (item.pallets * (item.product?.packsPerPallet || 1));
      const stockValue = totalPacks * parseFloat(item.product?.pricePerPack || 0);

      const inventoryItem = {
        id: item.id,
        productName: item.product?.name,
        productNo: item.product?.productNo,
        totalPacks,
        stockValue: parseFloat(stockValue.toFixed(2)),
        reorderLevel: item.reorderLevel,
        maxStockLevel: item.maxStockLevel,
        location: item.location
      };

      if (totalPacks === 0) {
        categorizedInventory.outOfStock.push(inventoryItem);
      } else if (totalPacks <= item.reorderLevel) {
        categorizedInventory.lowStock.push(inventoryItem);
      } else if (item.maxStockLevel && totalPacks > item.maxStockLevel) {
        categorizedInventory.overStock.push(inventoryItem);
      } else {
        categorizedInventory.inStock.push(inventoryItem);
      }
    });

    res.json({
      success: true,
      data: {
        summary: {
          totalItems: inventory.length,
          inStock: categorizedInventory.inStock.length,
          lowStock: categorizedInventory.lowStock.length,
          outOfStock: categorizedInventory.outOfStock.length,
          overStock: categorizedInventory.overStock.length
        },
        inventory: categorizedInventory
      }
    });
  })
);

// GET /api/v1/analytics/warehouse/inventory/performance
router.get('/inventory/performance',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('productId').optional().isString()
  ],
  asyncHandler(async (req, res) => {
    const { startDate, endDate, productId } = req.query;

    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.lte = new Date(endDate);
    }

    const productFilter = productId ? { productId } : {};

    const [
      salesData,
      purchasesData,
      currentInventory,
      turnoverAnalysis
    ] = await Promise.all([
      // Sales analysis
      prisma.warehouseSale.groupBy({
        by: ['productId'],
        where: { ...dateFilter, ...productFilter },
        _sum: {
          quantity: true,
          totalAmount: true,
          totalCost: true,
          grossProfit: true
        },
        _count: true
      }),

      // Purchase analysis
      prisma.warehouseProductPurchase.groupBy({
        by: ['productId'],
        where: { ...dateFilter, ...productFilter },
        _sum: {
          quantity: true,
          totalCost: true
        },
        _count: true
      }),

      // Current inventory levels
      prisma.warehouseInventory.findMany({
        where: productFilter,
        include: {
          product: {
            select: {
              id: true,
              name: true,
              productNo: true,
              pricePerPack: true,
              costPerPack: true,
              packsPerPallet: true
            }
          }
        }
      }),

      // Turnover rate calculation
      prisma.$queryRaw`
        SELECT 
          p.id,
          p.name,
          p.product_no,
          wi.packs as current_stock,
          COALESCE(sales.total_sold, 0) as total_sold,
          COALESCE(purchases.total_purchased, 0) as total_purchased,
          CASE 
            WHEN wi.packs > 0 AND COALESCE(sales.total_sold, 0) > 0 
            THEN ROUND(COALESCE(sales.total_sold, 0)::numeric / wi.packs, 2)
            ELSE 0 
          END as turnover_ratio,
          CASE 
            WHEN COALESCE(sales.total_sold, 0) > 0 
            THEN ROUND(wi.packs::numeric / NULLIF(sales.total_sold, 0) * 30, 0)
            ELSE NULL
          END as days_of_stock
        FROM products p
        LEFT JOIN warehouse_inventory wi ON p.id = wi.product_id
        LEFT JOIN (
          SELECT 
            product_id,
            SUM(quantity) as total_sold
          FROM warehouse_sales
          WHERE created_at >= ${startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)}
          GROUP BY product_id
        ) sales ON p.id = sales.product_id
        LEFT JOIN (
          SELECT 
            product_id,
            SUM(quantity) as total_purchased
          FROM warehouse_product_purchases
          WHERE purchase_date >= ${startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)}
          GROUP BY product_id
        ) purchases ON p.id = purchases.product_id
        ${productId ? Prisma.sql`WHERE p.id = ${productId}` : Prisma.empty}
        ORDER BY turnover_ratio DESC
      `
    ]);

    // Merge data
    const productMap = {};

    salesData.forEach(sale => {
      if (!productMap[sale.productId]) {
        productMap[sale.productId] = {
          productId: sale.productId,
          sales: sale,
          purchases: null,
          inventory: null
        };
      } else {
        productMap[sale.productId].sales = sale;
      }
    });

    purchasesData.forEach(purchase => {
      if (!productMap[purchase.productId]) {
        productMap[purchase.productId] = {
          productId: purchase.productId,
          sales: null,
          purchases: purchase,
          inventory: null
        };
      } else {
        productMap[purchase.productId].purchases = purchase;
      }
    });

    currentInventory.forEach(inv => {
      if (!productMap[inv.productId]) {
        productMap[inv.productId] = {
          productId: inv.productId,
          sales: null,
          purchases: null,
          inventory: inv
        };
      } else {
        productMap[inv.productId].inventory = inv;
      }
    });

    const performanceData = Object.values(productMap).map(item => {
      const turnoverData = turnoverAnalysis.find(t => t.id === item.productId);
      
      return {
        product: item.inventory?.product || turnoverData,
        sales: {
          totalSales: item.sales?._count || 0,
          quantitySold: item.sales?._sum.quantity || 0,
          revenue: item.sales?._sum.totalAmount || 0,
          cost: item.sales?._sum.totalCost || 0,
          profit: item.sales?._sum.grossProfit || 0
        },
        purchases: {
          totalPurchases: item.purchases?._count || 0,
          quantityPurchased: item.purchases?._sum.quantity || 0,
          purchaseCost: item.purchases?._sum.totalCost || 0
        },
        inventory: {
          currentStock: item.inventory?.packs || 0,
          reorderLevel: item.inventory?.reorderLevel || 0,
          status: item.inventory?.packs <= item.inventory?.reorderLevel 
            ? 'LOW_STOCK' 
            : 'IN_STOCK'
        },
        metrics: {
          turnoverRatio: turnoverData?.turnover_ratio || 0,
          daysOfStock: turnoverData?.days_of_stock || null,
          profitMargin: item.sales?._sum.totalAmount 
            ? ((item.sales._sum.grossProfit / item.sales._sum.totalAmount) * 100).toFixed(2)
            : 0
        }
      };
    });

    // Sort by best performers (highest turnover + profit)
    performanceData.sort((a, b) => {
      const scoreA = (a.metrics.turnoverRatio * 0.5) + (parseFloat(a.metrics.profitMargin) * 0.5);
      const scoreB = (b.metrics.turnoverRatio * 0.5) + (parseFloat(b.metrics.profitMargin) * 0.5);
      return scoreB - scoreA;
    });

    res.json({
      success: true,
      data: {
        products: performanceData,
        summary: {
          totalProducts: performanceData.length,
          totalRevenue: performanceData.reduce((sum, p) => sum + parseFloat(p.sales.revenue), 0),
          totalProfit: performanceData.reduce((sum, p) => sum + parseFloat(p.sales.profit), 0),
          averageTurnover: performanceData.reduce((sum, p) => sum + parseFloat(p.metrics.turnoverRatio), 0) / performanceData.length
        }
      }
    });
  })
);

module.exports = router;
