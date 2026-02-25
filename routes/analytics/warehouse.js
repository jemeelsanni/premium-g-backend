// routes/analytics/warehouse.js - Warehouse-only analytics

const express = require('express');
const { query, validationResult } = require('express-validator');

const { asyncHandler, ValidationError } = require('../../middleware/errorHandler');
const { authorizeModule } = require('../../middleware/auth');
const { authorizeRole } = require('../../middleware/auth'); // Import authorizeRole

const router = express.Router();
const prisma = require('../../lib/prisma');

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

    // 🆕 Fetch data with date filter (added debtorStats, expenses, expensesByType, customerSales)
    const [sales, cashFlow, inventory, customers, debtorStats, expenses, expensesByType, customerSales] = await Promise.all([
      prisma.warehouseSale.findMany({
        where: {
          createdAt: { ...dateFilter }
        },
        include: {
          product: { select: { name: true, productNo: true } },
          warehouseCustomer: { select: { id: true, name: true } }
        }
      }),

      prisma.cashFlow.findMany({
        where: {
          createdAt: { ...dateFilter }
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
            { sales: { some: { createdAt: { ...dateFilter } } } }
          ]
        },
        select: { id: true, isActive: true }
      }),

      // 🆕 NEW: Debtor statistics
      prisma.debtor.aggregate({
        where: {
          createdAt: { ...dateFilter },
          status: { in: ['OUTSTANDING', 'PARTIAL', 'OVERDUE'] } // Only active debts
        },
        _sum: {
          totalAmount: true,
          amountPaid: true,
          amountDue: true
        },
        _count: true
      }),

      // 🆕 NEW: Warehouse expenses (approved only)
      prisma.warehouseExpense.aggregate({
        where: {
          expenseDate: { ...dateFilter },
          status: 'APPROVED' // Only count approved expenses
        },
        _sum: {
          amount: true
        }
      }),

      // 🆕 NEW: Expense breakdown by type
      prisma.warehouseExpense.groupBy({
        by: ['expenseType'],
        where: {
          expenseDate: { ...dateFilter },
          status: 'APPROVED'
        },
        _sum: {
          amount: true
        }
      }),

      // 🆕 NEW: Customer sales aggregation
      prisma.warehouseSale.groupBy({
        by: ['warehouseCustomerId'],
        where: {
          createdAt: { ...dateFilter },
          warehouseCustomerId: { not: null }
        },
        _sum: {
          totalAmount: true,
          totalCost: true,
          grossProfit: true
        },
        _count: true
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
          cogs: 0,
          quantity: 0,
          grossProfit: 0
        };
      }
      productStats[productName].sales += 1;
      productStats[productName].revenue += revenue;
      productStats[productName].cogs += cost;
      productStats[productName].quantity += sale.quantity;
      productStats[productName].grossProfit += parseFloat(sale.grossProfit);

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

    // ✅ FIXED (using purchase cost from batches):
    for (const item of inventory) {
      const stockLevel = item.packs + (item.pallets * (item.product?.packsPerPallet || 1));
      
      // Get weighted average cost from active batches
      const activeBatches = await prisma.warehouseProductPurchase.findMany({
        where: {
          productId: item.productId,
          batchStatus: 'ACTIVE',
          quantityRemaining: { gt: 0 }
        },
        select: {
          costPerUnit: true,
          quantityRemaining: true
        }
      });
      
      let weightedAvgCost = 0;
      if (activeBatches.length > 0) {
        const totalCost = activeBatches.reduce((sum, batch) => 
          sum + (parseFloat(batch.costPerUnit) * batch.quantityRemaining), 0
        );
        const totalQty = activeBatches.reduce((sum, batch) => 
          sum + batch.quantityRemaining, 0
        );
        weightedAvgCost = totalQty > 0 ? totalCost / totalQty : 0;
      }
      
      const stockValue = stockLevel * weightedAvgCost;
      totalStockValue += stockValue;
      
      if (stockLevel === 0) {
        outOfStockItems++;
      } else if (stockLevel <= item.reorderLevel) {
        lowStockItems++;
      }
    }

    const grossProfit = totalRevenue - totalCOGS;
    const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const averageSaleValue = sales.length > 0 ? totalRevenue / sales.length : 0;
    const netCashFlow = totalCashIn - totalCashOut;

    const totalCustomers = await prisma.warehouseCustomer.count();
    const activeCustomers = customers.length; // Active customers in the filtered period

    // 🆕 NEW: Net Profitability Calculations
    const totalExpenses = parseFloat(expenses._sum.amount || 0);
    const netProfit = grossProfit - totalExpenses;
    const netProfitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    // Cost ratios
    const cogsRatio = totalRevenue > 0 ? (totalCOGS / totalRevenue) * 100 : 0;
    const expenseRatio = totalRevenue > 0 ? (totalExpenses / totalRevenue) * 100 : 0;

    // Efficiency metrics
    const revenuePerCustomer = activeCustomers > 0 ? totalRevenue / activeCustomers : 0;
    const profitPerSale = sales.length > 0 ? netProfit / sales.length : 0;

    // 🆕 NEW: Expense Breakdown by Category
    const expenseBreakdown = expensesByType.reduce((acc, item) => {
      const category = item.expenseType.toLowerCase();
      acc[category] = parseFloat(item._sum.amount || 0);
      return acc;
    }, {});

    // 🆕 NEW: Top Products with Net Profit (allocate expenses proportionally)
    const topProducts = Object.entries(productStats)
      .map(([name, stats]) => {
        const allocatedExpenses = totalRevenue > 0
          ? (stats.revenue / totalRevenue) * totalExpenses
          : 0;
        const netProfit = stats.grossProfit - allocatedExpenses;
        const netProfitMargin = stats.revenue > 0
          ? (netProfit / stats.revenue) * 100
          : 0;

        return {
          productName: name,
          sales: stats.sales,
          revenue: parseFloat(stats.revenue.toFixed(2)),
          cogs: parseFloat(stats.cogs.toFixed(2)),
          quantity: stats.quantity,
          grossProfit: parseFloat(stats.grossProfit.toFixed(2)),
          allocatedExpenses: parseFloat(allocatedExpenses.toFixed(2)),
          netProfit: parseFloat(netProfit.toFixed(2)),
          netProfitMargin: parseFloat(netProfitMargin.toFixed(2))
        };
      })
      .sort((a, b) => b.netProfit - a.netProfit)
      .slice(0, 10);

    // 🆕 NEW: Top Profitable Customers
    const profitableCustomers = await Promise.all(
      customerSales
        .map(async (customerSale) => {
          if (!customerSale.warehouseCustomerId) return null;

          const customer = await prisma.warehouseCustomer.findUnique({
            where: { id: customerSale.warehouseCustomerId },
            select: {
              id: true,
              name: true,
              outstandingDebt: true
            }
          });

          if (!customer) return null;

          const revenue = parseFloat(customerSale._sum.totalAmount || 0);
          const cogs = parseFloat(customerSale._sum.totalCost || 0);
          const grossProfit = parseFloat(customerSale._sum.grossProfit || 0);

          // Allocate expenses proportionally to this customer
          const allocatedExpenses = totalRevenue > 0
            ? (revenue / totalRevenue) * totalExpenses
            : 0;
          const netProfit = grossProfit - allocatedExpenses;
          const netProfitMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

          return {
            customerId: customer.id,
            customerName: customer.name,
            orderCount: customerSale._count,
            revenue: parseFloat(revenue.toFixed(2)),
            cogs: parseFloat(cogs.toFixed(2)),
            grossProfit: parseFloat(grossProfit.toFixed(2)),
            allocatedExpenses: parseFloat(allocatedExpenses.toFixed(2)),
            netProfit: parseFloat(netProfit.toFixed(2)),
            netProfitMargin: parseFloat(netProfitMargin.toFixed(2)),
            outstandingDebt: parseFloat(customer.outstandingDebt || 0)
          };
        })
    );

    const topCustomers = profitableCustomers
      .filter(c => c !== null)
      .sort((a, b) => b.netProfit - a.netProfit)
      .slice(0, 10);

    const dailyPerformance = Object.entries(dailySales)
      .map(([date, stats]) => ({ date, ...stats }))
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 7);

    res.json({
      success: true,
      data: {
        summary: {
          // Revenue & Costs
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalCOGS: parseFloat(totalCOGS.toFixed(2)),
          totalExpenses: parseFloat(totalExpenses.toFixed(2)),

          // Profitability
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          netProfit: parseFloat(netProfit.toFixed(2)),
          grossProfitMargin: parseFloat(profitMargin.toFixed(2)),
          netProfitMargin: parseFloat(netProfitMargin.toFixed(2)),

          // Cost Ratios
          cogsRatio: parseFloat(cogsRatio.toFixed(2)),
          expenseRatio: parseFloat(expenseRatio.toFixed(2)),

          // Sales Metrics
          totalSales: sales.length,
          totalQuantitySold,
          averageSaleValue: parseFloat(averageSaleValue.toFixed(2)),

          // Efficiency Metrics
          revenuePerCustomer: parseFloat(revenuePerCustomer.toFixed(2)),
          profitPerSale: parseFloat(profitPerSale.toFixed(2)),

          // Customer Metrics
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
            parseFloat(((inventory.length - lowStockItems - outOfStockItems) / inventory.length * 100).toFixed(2)) : 0
        },

        // 🆕 NEW: Expense Breakdown
        expenseBreakdown: {
          total: parseFloat(totalExpenses.toFixed(2)),
          byCategory: expenseBreakdown
        },

        // 🆕 NEW: Debtor summary
        debtorSummary: {
          totalDebtors: debtorStats._count || 0,
          totalOutstanding: parseFloat((debtorStats._sum.amountDue || 0).toFixed(2)),
          totalCreditSales: parseFloat((debtorStats._sum.totalAmount || 0).toFixed(2)),
          totalPaid: parseFloat((debtorStats._sum.amountPaid || 0).toFixed(2))
        },

        customerSummary: {
          totalCustomers,
          activeCustomers
        },

        // 🆕 ENHANCED: Top products now include net profit
        topProducts,

        // 🆕 NEW: Top profitable customers
        topCustomers,

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

// ✅ FIXED: Calculate stock value using purchase cost from batches
for (const item of inventory) {
  const totalPacks = item.packs + (item.pallets * (item.product?.packsPerPallet || 1));
  
  // Get weighted average cost from active batches
  const activeBatches = await prisma.warehouseProductPurchase.findMany({
    where: {
      productId: item.productId,
      batchStatus: 'ACTIVE',
      quantityRemaining: { gt: 0 }
    },
    select: {
      costPerUnit: true,
      quantityRemaining: true
    }
  });
  
  let weightedAvgCost = 0;
  if (activeBatches.length > 0) {
    const totalCost = activeBatches.reduce((sum, batch) => 
      sum + (parseFloat(batch.costPerUnit) * batch.quantityRemaining), 0
    );
    const totalQty = activeBatches.reduce((sum, batch) => 
      sum + batch.quantityRemaining, 0
    );
    weightedAvgCost = totalQty > 0 ? totalCost / totalQty : 0;
  }
  
  const stockValue = totalPacks * weightedAvgCost;

  const inventoryItem = {
    id: item.id,
    productName: item.product?.name,
    productNo: item.product?.productNo,
    totalPacks,
    stockValue: parseFloat(stockValue.toFixed(2)),
    costPerUnit: parseFloat(weightedAvgCost.toFixed(2)), // ✅ Added for transparency
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
}
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
