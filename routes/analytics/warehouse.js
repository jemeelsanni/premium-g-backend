// routes/analytics/warehouse.js - Warehouse-only analytics

const express = require('express');
const { query, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError } = require('../../middleware/errorHandler');
const { authorizeModule } = require('../../middleware/auth');
const { authorizeRole } = require('../../middleware/auth'); // Import authorizeRole

const router = express.Router();
const prisma = new PrismaClient();

// Get warehouse analytics summary
router.get('/summary',
  authorizeModule('warehouse'),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    // Get warehouse sales, cash flow, inventory, and customers
    const [sales, cashFlow, inventory, customers] = await Promise.all([
      prisma.warehouseSale.findMany({
        where: {
          createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined
        },
        include: {
          product: { select: { name: true, productNo: true } }
        }
      }),
      
      prisma.cashFlow.findMany({
        where: {
          createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined
        }
      }),
      
      prisma.warehouseInventory.findMany({
        include: {
          product: { select: { name: true, productNo: true, packsPerPallet: true, pricePerPack: true } }
        }
      }),

      prisma.warehouseCustomer.findMany({
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

    const totalCustomers = customers.length;
    const activeCustomers = customers.filter(customer => customer.isActive !== false).length;

    // Top products
    const topProducts = Object.entries(productStats)
      .map(([name, stats]) => ({ productName: name, ...stats }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // Recent daily performance
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
        period: { startDate, endDate }
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

module.exports = router;

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

module.exports = router;
