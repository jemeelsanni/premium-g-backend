const express = require('express');
const { query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// UTILITY FUNCTIONS
// ================================

const calculateOrderProfitability = async (orderId) => {
  // Get distribution order with all related data
  const order = await prisma.distributionOrder.findUnique({
    where: { id: orderId },
    include: {
      orderItems: {
        include: {
          product: true
        }
      },
      transportOrder: true,
      location: true
    }
  });

  if (!order) return null;

  // Calculate cost of goods sold (COGS)
  let totalCOGS = 0;
  for (const item of order.orderItems) {
    const itemPacks = (item.pallets * item.product.packsPerPallet) + item.packs;
    totalCOGS += itemPacks * parseFloat(item.product.costPerPack || 0);
  }

  // Get associated expenses
  const expenses = await prisma.expense.findMany({
    where: {
      referenceId: orderId,
      status: 'APPROVED'
    }
  });

  const totalExpenses = expenses.reduce((sum, expense) => sum + parseFloat(expense.amount), 0);

  // Calculate transport costs if available
  let transportCosts = 0;
  if (order.transportOrder) {
    transportCosts = parseFloat(order.transportOrder.totalExpenses || 0);
  }

  // Calculate profit metrics
  const totalRevenue = parseFloat(order.finalAmount);
  const totalCosts = totalCOGS + totalExpenses + transportCosts;
  const grossProfit = totalRevenue - totalCOGS;
  const netProfit = totalRevenue - totalCosts;
  const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  return {
    orderId,
    totalRevenue,
    costOfGoodsSold: totalCOGS,
    operationalExpenses: totalExpenses,
    transportCosts,
    totalCosts,
    grossProfit,
    netProfit,
    profitMargin: parseFloat(profitMargin.toFixed(2)),
    orderDetails: {
      totalPacks: order.totalPacks,
      totalPallets: order.totalPallets,
      customerName: order.customer?.name,
      locationName: order.location?.name
    }
  };
};

const generatePeriodAnalysis = async (period, startDate, endDate) => {
  // Get all relevant data for the period
  const [
    distributionOrders,
    transportOrders,
    warehouseSales,
    expenses
  ] = await Promise.all([
    prisma.distributionOrder.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        status: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
      },
      include: {
        orderItems: {
          include: { product: true }
        }
      }
    }),
    
    prisma.transportOrder.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
      }
    }),
    
    prisma.warehouseSale.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate }
      }
    }),
    
    prisma.expense.findMany({
      where: {
        expenseDate: { gte: startDate, lte: endDate },
        status: 'APPROVED'
      }
    })
  ]);

  // Calculate distribution revenue and COGS
  let distributionRevenue = 0;
  let totalCOGS = 0;
  
  for (const order of distributionOrders) {
    distributionRevenue += parseFloat(order.finalAmount);
    
    for (const item of order.orderItems) {
      const itemPacks = (item.pallets * item.product.packsPerPallet) + item.packs;
      totalCOGS += itemPacks * parseFloat(item.product.costPerPack || 0);
    }
  }

  // Calculate transport revenue (this should be net profit from transport)
  const transportRevenue = transportOrders.reduce((sum, order) => 
    sum + parseFloat(order.netProfit || 0), 0
  );

  // Calculate warehouse revenue
  const warehouseRevenue = warehouseSales.reduce((sum, sale) => 
    sum + parseFloat(sale.totalAmount), 0
  );

  // Calculate total expenses by category
  const expenseBreakdown = expenses.reduce((acc, expense) => {
    const category = expense.category;
    acc[category] = (acc[category] || 0) + parseFloat(expense.amount);
    return acc;
  }, {});

  const totalExpenses = expenses.reduce((sum, expense) => 
    sum + parseFloat(expense.amount), 0
  );

  // Calculate final metrics
  const totalRevenue = distributionRevenue + transportRevenue + warehouseRevenue;
  const totalCosts = totalCOGS + totalExpenses;
  const grossProfit = totalRevenue - totalCOGS;
  const netProfit = totalRevenue - totalCosts;
  const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  return {
    period,
    startDate,
    endDate,
    revenue: {
      distribution: distributionRevenue,
      transport: transportRevenue,
      warehouse: warehouseRevenue,
      total: totalRevenue
    },
    costs: {
      costOfGoodsSold: totalCOGS,
      operationalExpenses: totalExpenses,
      total: totalCosts,
      breakdown: expenseBreakdown
    },
    profit: {
      gross: grossProfit,
      net: netProfit,
      margin: parseFloat(profitMargin.toFixed(2))
    },
    orderMetrics: {
      distributionOrders: distributionOrders.length,
      transportOrders: transportOrders.length,
      warehouseSales: warehouseSales.length
    }
  };
};

// ================================
// PROFIT ANALYSIS ROUTES
// ================================

// @route   GET /api/v1/analytics/profit/order/:orderId
// @desc    Get profit analysis for specific order
// @access  Private (Admin or order creator)
router.get('/order/:orderId',
  param('orderId').custom(validateCuid('order ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { orderId } = req.params;

    // Check if user has access to this order
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId },
      include: { createdByUser: { select: { id: true } } }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // Check permissions
    if (!req.user.role.includes('ADMIN') && 
        req.user.role !== 'SUPER_ADMIN' && 
        order.createdBy !== req.user.id) {
      throw new BusinessError('Access denied', 'ACCESS_DENIED');
    }

    const profitAnalysis = await calculateOrderProfitability(orderId);

    if (!profitAnalysis) {
      throw new NotFoundError('Order not found or invalid');
    }

    res.json({
      success: true,
      data: { profitAnalysis }
    });
  })
);

// @route   GET /api/v1/analytics/profit/monthly
// @desc    Get monthly profit analysis
// @access  Private (Admin)
router.get('/monthly',
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const { year, month } = req.query;
    
    const currentDate = new Date();
    const targetYear = year ? parseInt(year) : currentDate.getFullYear();
    const targetMonth = month ? parseInt(month) : currentDate.getMonth() + 1;

    // Calculate date range
    const startDate = new Date(targetYear, targetMonth - 1, 1);
    const endDate = new Date(targetYear, targetMonth, 0, 23, 59, 59);

    const monthlyAnalysis = await generatePeriodAnalysis('monthly', startDate, endDate);

    // Get target performance for comparison
    const target = await prisma.distributionTarget.findUnique({
      where: { 
        year_month: { 
          year: targetYear, 
          month: targetMonth 
        } 
      },
      include: {
        weeklyPerformances: true
      }
    });

    let targetComparison = null;
    if (target) {
      const totalActualPacks = target.weeklyPerformances.reduce(
        (sum, week) => sum + week.actualPacks, 0
      );
      const targetAchievement = target.totalPacksTarget > 0 ? 
        (totalActualPacks / target.totalPacksTarget) * 100 : 0;

      targetComparison = {
        targetPacks: target.totalPacksTarget,
        actualPacks: totalActualPacks,
        achievement: parseFloat(targetAchievement.toFixed(2)),
        revenuePerPack: totalActualPacks > 0 ? 
          monthlyAnalysis.revenue.distribution / totalActualPacks : 0
      };
    }

    res.json({
      success: true,
      data: {
        analysis: monthlyAnalysis,
        targetComparison,
        insights: {
          profitPerOrder: monthlyAnalysis.orderMetrics.distributionOrders > 0 ?
            monthlyAnalysis.profit.net / monthlyAnalysis.orderMetrics.distributionOrders : 0,
          revenueGrowth: null, // Would need previous month data
          costEfficiency: monthlyAnalysis.revenue.total > 0 ?
            (monthlyAnalysis.costs.total / monthlyAnalysis.revenue.total) * 100 : 0
        }
      }
    });
  })
);

// @route   GET /api/v1/analytics/profit/yearly
// @desc    Get yearly profit analysis with monthly breakdown
// @access  Private (Admin)
router.get('/yearly',
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const { year } = req.query;
    const targetYear = year ? parseInt(year) : new Date().getFullYear();

    // Calculate yearly totals
    const startDate = new Date(targetYear, 0, 1);
    const endDate = new Date(targetYear, 11, 31, 23, 59, 59);

    const yearlyAnalysis = await generatePeriodAnalysis('yearly', startDate, endDate);

    // Get monthly breakdown
    const monthlyBreakdown = [];
    for (let month = 1; month <= 12; month++) {
      const monthStart = new Date(targetYear, month - 1, 1);
      const monthEnd = new Date(targetYear, month, 0, 23, 59, 59);
      
      const monthAnalysis = await generatePeriodAnalysis('monthly', monthStart, monthEnd);
      monthlyBreakdown.push({
        month,
        monthName: monthStart.toLocaleString('default', { month: 'long' }),
        ...monthAnalysis
      });
    }

    // Calculate year-over-year comparison if previous year data exists
    let yearOverYearComparison = null;
    if (targetYear > 2020) {
      const prevYearStart = new Date(targetYear - 1, 0, 1);
      const prevYearEnd = new Date(targetYear - 1, 11, 31, 23, 59, 59);
      
      const prevYearAnalysis = await generatePeriodAnalysis('yearly', prevYearStart, prevYearEnd);
      
      const revenueGrowth = prevYearAnalysis.revenue.total > 0 ?
        ((yearlyAnalysis.revenue.total - prevYearAnalysis.revenue.total) / prevYearAnalysis.revenue.total) * 100 : 0;
      
      const profitGrowth = prevYearAnalysis.profit.net > 0 ?
        ((yearlyAnalysis.profit.net - prevYearAnalysis.profit.net) / Math.abs(prevYearAnalysis.profit.net)) * 100 : 0;

      yearOverYearComparison = {
        previousYear: targetYear - 1,
        revenueGrowth: parseFloat(revenueGrowth.toFixed(2)),
        profitGrowth: parseFloat(profitGrowth.toFixed(2)),
        marginImprovement: yearlyAnalysis.profit.margin - prevYearAnalysis.profit.margin
      };
    }

    res.json({
      success: true,
      data: {
        year: targetYear,
        yearlyAnalysis,
        monthlyBreakdown,
        yearOverYearComparison,
        insights: {
          bestMonth: monthlyBreakdown.reduce((best, current) => 
            current.profit.net > best.profit.net ? current : best, monthlyBreakdown[0]
          ),
          worstMonth: monthlyBreakdown.reduce((worst, current) => 
            current.profit.net < worst.profit.net ? current : worst, monthlyBreakdown[0]
          ),
          avgMonthlyProfit: yearlyAnalysis.profit.net / 12
        }
      }
    });
  })
);

// @route   GET /api/v1/analytics/profit/location/:locationId
// @desc    Get profit analysis by location
// @access  Private (Admin)
router.get('/location/:locationId',
  param('locationId').custom(validateCuid('location ID')),
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN']),
  asyncHandler(async (req, res) => {
    const { locationId } = req.params;
    const { startDate, endDate, period = '30' } = req.query;

    // Verify location exists
    const location = await prisma.location.findUnique({
      where: { id: locationId }
    });

    if (!location) {
      throw new NotFoundError('Location not found');
    }

    // Set date range
    const endDateTime = endDate ? new Date(endDate) : new Date();
    const startDateTime = startDate ? new Date(startDate) : 
      new Date(endDateTime.getTime() - (parseInt(period) * 24 * 60 * 60 * 1000));

    // Get location-specific data
    const [
      distributionOrders,
      transportOrders,
      expenses
    ] = await Promise.all([
      prisma.distributionOrder.findMany({
        where: {
          locationId,
          createdAt: { gte: startDateTime, lte: endDateTime },
          status: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
        },
        include: {
          orderItems: {
            include: { product: true }
          },
          customer: { select: { name: true } }
        }
      }),

      prisma.transportOrder.findMany({
        where: {
          locationId,
          createdAt: { gte: startDateTime, lte: endDateTime }
        }
      }),

      prisma.expense.findMany({
        where: {
          locationId,
          expenseDate: { gte: startDateTime, lte: endDateTime },
          status: 'APPROVED'
        }
      })
    ]);

    // Calculate location-specific metrics
    let distributionRevenue = 0;
    let totalCOGS = 0;
    let totalPacks = 0;

    for (const order of distributionOrders) {
      distributionRevenue += parseFloat(order.finalAmount);
      totalPacks += order.totalPacks;
      
      for (const item of order.orderItems) {
        const itemPacks = (item.pallets * item.product.packsPerPallet) + item.packs;
        totalCOGS += itemPacks * parseFloat(item.product.costPerPack || 0);
      }
    }

    const transportRevenue = transportOrders.reduce((sum, order) => 
      sum + parseFloat(order.netProfit || 0), 0);

    const totalExpenses = expenses.reduce((sum, expense) => 
      sum + parseFloat(expense.amount), 0);

    const totalRevenue = distributionRevenue + transportRevenue;
    const totalCosts = totalCOGS + totalExpenses;
    const netProfit = totalRevenue - totalCosts;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    // Calculate delivery efficiency metrics
    const deliveryMetrics = {
      totalDeliveries: transportOrders.length,
      avgDeliveryValue: transportOrders.length > 0 ? 
        transportOrders.reduce((sum, order) => sum + parseFloat(order.totalOrderAmount), 0) / transportOrders.length : 0,
      avgFuelCostPerDelivery: transportOrders.length > 0 ?
        transportOrders.reduce((sum, order) => sum + parseFloat(order.totalFuelCost || 0), 0) / transportOrders.length : 0
    };

    res.json({
      success: true,
      data: {
        location,
        period: { startDate: startDateTime, endDate: endDateTime },
        financials: {
          revenue: {
            distribution: distributionRevenue,
            transport: transportRevenue,
            total: totalRevenue
          },
          costs: {
            costOfGoodsSold: totalCOGS,
            expenses: totalExpenses,
            total: totalCosts
          },
          profit: {
            net: netProfit,
            margin: parseFloat(profitMargin.toFixed(2))
          }
        },
        operationalMetrics: {
          totalOrders: distributionOrders.length,
          totalPacks,
          revenuePerPack: totalPacks > 0 ? distributionRevenue / totalPacks : 0,
          ...deliveryMetrics
        },
        expenseBreakdown: expenses.reduce((acc, expense) => {
          const category = expense.category;
          acc[category] = (acc[category] || 0) + parseFloat(expense.amount);
          return acc;
        }, {}),
        topCustomers: Object.values(
          distributionOrders.reduce((acc, order) => {
            const customerName = order.customer?.name || 'Unknown';
            if (!acc[customerName]) {
              acc[customerName] = { name: customerName, revenue: 0, orders: 0 };
            }
            acc[customerName].revenue += parseFloat(order.finalAmount);
            acc[customerName].orders += 1;
            return acc;
          }, {})
        ).sort((a, b) => b.revenue - a.revenue).slice(0, 5)
      }
    });
  })
);

// @route   GET /api/v1/analytics/profit/customer/:customerId
// @desc    Get profit analysis by customer
// @access  Private (Admin)
router.get('/customer/:customerId',
  param('customerId').custom(validateCuid('customer ID')),
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN']),
  asyncHandler(async (req, res) => {
    const { customerId } = req.params;
    const { startDate, endDate, period = '90' } = req.query;

    // Verify customer exists
    const customer = await prisma.customer.findUnique({
      where: { id: customerId }
    });

    if (!customer) {
      throw new NotFoundError('Customer not found');
    }

    // Set date range
    const endDateTime = endDate ? new Date(endDate) : new Date();
    const startDateTime = startDate ? new Date(startDate) : 
      new Date(endDateTime.getTime() - (parseInt(period) * 24 * 60 * 60 * 1000));

    // Get customer orders
    const orders = await prisma.distributionOrder.findMany({
      where: {
        customerId,
        createdAt: { gte: startDateTime, lte: endDateTime }
      },
      include: {
        orderItems: {
          include: { product: true }
        },
        location: { select: { name: true } },
        transportOrder: true
      },
      orderBy: { createdAt: 'desc' }
    });

    // Calculate customer profitability
    let totalRevenue = 0;
    let totalCOGS = 0;
    let totalTransportCosts = 0;
    const orderAnalytics = [];

    for (const order of orders) {
      const orderRevenue = parseFloat(order.finalAmount);
      let orderCOGS = 0;
      
      for (const item of order.orderItems) {
        const itemPacks = (item.pallets * item.product.packsPerPallet) + item.packs;
        orderCOGS += itemPacks * parseFloat(item.product.costPerPack || 0);
      }

      const transportCost = order.transportOrder ? 
        parseFloat(order.transportOrder.totalExpenses || 0) : 0;

      totalRevenue += orderRevenue;
      totalCOGS += orderCOGS;
      totalTransportCosts += transportCost;

      orderAnalytics.push({
        orderId: order.id,
        orderDate: order.createdAt,
        revenue: orderRevenue,
        cogs: orderCOGS,
        transportCost,
        netProfit: orderRevenue - orderCOGS - transportCost,
        location: order.location?.name,
        status: order.status
      });
    }

    const totalCosts = totalCOGS + totalTransportCosts;
    const netProfit = totalRevenue - totalCosts;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    // Calculate customer metrics
    const avgOrderValue = orders.length > 0 ? totalRevenue / orders.length : 0;
    const avgOrderProfit = orders.length > 0 ? netProfit / orders.length : 0;

    // Customer lifetime value (simplified)
    const orderFrequency = orders.length / (period / 30); // orders per month
    const clv = avgOrderProfit * orderFrequency * 12; // simplified annual CLV

    res.json({
      success: true,
      data: {
        customer,
        period: { startDate: startDateTime, endDate: endDateTime },
        summary: {
          totalOrders: orders.length,
          totalRevenue,
          totalCosts,
          netProfit,
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          avgOrderValue,
          avgOrderProfit,
          customerLifetimeValue: clv
        },
        orderHistory: orderAnalytics,
        insights: {
          mostProfitableOrder: orderAnalytics.reduce((best, current) => 
            current.netProfit > best.netProfit ? current : best, orderAnalytics[0] || {}),
          preferredLocation: Object.values(
            orders.reduce((acc, order) => {
              const location = order.location?.name || 'Unknown';
              acc[location] = (acc[location] || 0) + 1;
              return acc;
            }, {})
          ).length > 0 ? Object.keys(
            orders.reduce((acc, order) => {
              const location = order.location?.name || 'Unknown';
              acc[location] = (acc[location] || 0) + 1;
              return acc;
            }, {})
          ).reduce((a, b) => 
            orders.filter(o => o.location?.name === a).length > 
            orders.filter(o => o.location?.name === b).length ? a : b
          ) : null
        }
      }
    });
  })
);

// @route   GET /api/v1/analytics/profit/dashboard
// @desc    Get comprehensive profit dashboard
// @access  Private (Admin)
router.get('/dashboard',
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const { period = '30' } = req.query;
    const days = parseInt(period);

    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - (days * 24 * 60 * 60 * 1000));

    // Get current period analysis
    const currentAnalysis = await generatePeriodAnalysis('current', startDate, endDate);

    // Get previous period for comparison
    const prevEndDate = new Date(startDate.getTime() - (24 * 60 * 60 * 1000));
    const prevStartDate = new Date(prevEndDate.getTime() - (days * 24 * 60 * 60 * 1000));
    const previousAnalysis = await generatePeriodAnalysis('previous', prevStartDate, prevEndDate);

    // Calculate growth metrics
    const revenueGrowth = previousAnalysis.revenue.total > 0 ?
      ((currentAnalysis.revenue.total - previousAnalysis.revenue.total) / previousAnalysis.revenue.total) * 100 : 0;

    const profitGrowth = Math.abs(previousAnalysis.profit.net) > 0 ?
      ((currentAnalysis.profit.net - previousAnalysis.profit.net) / Math.abs(previousAnalysis.profit.net)) * 100 : 0;

    // Get top performing metrics
    const [
      topLocations,
      topCustomers,
      recentHighValueOrders
    ] = await Promise.all([
      // Top performing locations by profit
      prisma.$queryRaw`
        SELECT 
          l.id,
          l.name,
          COUNT(do.id) as order_count,
          SUM(do.final_amount) as total_revenue,
          AVG(do.final_amount) as avg_order_value
        FROM locations l
        JOIN distribution_orders do ON l.id = do.location_id
        WHERE do.created_at >= ${startDate}
          AND do.created_at <= ${endDate}
          AND do.status IN ('DELIVERED', 'PARTIALLY_DELIVERED')
        GROUP BY l.id, l.name
        ORDER BY total_revenue DESC
        LIMIT 5
      `,

      // Top customers by revenue
      prisma.$queryRaw`
        SELECT 
          c.id,
          c.name,
          COUNT(do.id) as order_count,
          SUM(do.final_amount) as total_revenue,
          AVG(do.final_amount) as avg_order_value
        FROM customers c
        JOIN distribution_orders do ON c.id = do.customer_id
        WHERE do.created_at >= ${startDate}
          AND do.created_at <= ${endDate}
          AND do.status IN ('DELIVERED', 'PARTIALLY_DELIVERED')
        GROUP BY c.id, c.name
        ORDER BY total_revenue DESC
        LIMIT 5
      `,

      // Recent high-value orders
      prisma.distributionOrder.findMany({
        where: {
          createdAt: { gte: startDate, lte: endDate },
          finalAmount: { gte: 50000 } // High-value threshold
        },
        include: {
          customer: { select: { name: true } },
          location: { select: { name: true } }
        },
        orderBy: { finalAmount: 'desc' },
        take: 10
      })
    ]);

    // Calculate key performance indicators
    const kpis = {
      revenuePerDay: currentAnalysis.revenue.total / days,
      profitPerDay: currentAnalysis.profit.net / days,
      avgOrderValue: currentAnalysis.orderMetrics.distributionOrders > 0 ?
        currentAnalysis.revenue.distribution / currentAnalysis.orderMetrics.distributionOrders : 0,
      costRatio: currentAnalysis.revenue.total > 0 ?
        (currentAnalysis.costs.total / currentAnalysis.revenue.total) * 100 : 0
    };

    res.json({
      success: true,
      data: {
        period: { days, startDate, endDate },
        currentPeriod: currentAnalysis,
        previousPeriod: previousAnalysis,
        growth: {
          revenue: parseFloat(revenueGrowth.toFixed(2)),
          profit: parseFloat(profitGrowth.toFixed(2)),
          marginChange: currentAnalysis.profit.margin - previousAnalysis.profit.margin
        },
        kpis,
        topPerformers: {
          locations: topLocations,
          customers: topCustomers,
          highValueOrders: recentHighValueOrders
        },
        alerts: {
          lowProfitMargin: currentAnalysis.profit.margin < 10,
          highCostRatio: kpis.costRatio > 80,
          negativeGrowth: revenueGrowth < -5
        }
      }
    });
  })
);

// @route   POST /api/v1/analytics/profit/recalculate
// @desc    Recalculate profit analysis for all orders (Admin only)
// @access  Private (Super Admin)
router.post('/recalculate',
  authorizeRole(['SUPER_ADMIN']),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.body;

    let whereClause = {};
    if (startDate || endDate) {
      whereClause.createdAt = {};
      if (startDate) whereClause.createdAt.gte = new Date(startDate);
      if (endDate) whereClause.createdAt.lte = new Date(endDate);
    }

    // Get all orders to recalculate
    const orders = await prisma.distributionOrder.findMany({
      where: whereClause,
      select: { id: true }
    });

    let processedCount = 0;
    const batchSize = 50;

    // Process in batches to avoid memory issues
    for (let i = 0; i < orders.length; i += batchSize) {
      const batch = orders.slice(i, i + batchSize);
      
      await Promise.all(
        batch.map(async (order) => {
          const analysis = await calculateOrderProfitability(order.id);
          
          if (analysis) {
            // Update or create profit analysis record
            await prisma.profitAnalysis.upsert({
              where: {
                analysisType_referenceId: {
                  analysisType: 'ORDER',
                  referenceId: order.id
                }
              },
              update: {
                totalRevenue: analysis.totalRevenue,
                distributionRevenue: analysis.totalRevenue,
                totalCosts: analysis.totalCosts,
                costOfGoodsSold: analysis.costOfGoodsSold,
                operationalExpenses: analysis.operationalExpenses,
                grossProfit: analysis.grossProfit,
                netProfit: analysis.netProfit,
                profitMargin: analysis.profitMargin
              },
              create: {
                analysisType: 'ORDER',
                referenceId: order.id,
                totalRevenue: analysis.totalRevenue,
                distributionRevenue: analysis.totalRevenue,
                totalCosts: analysis.totalCosts,
                costOfGoodsSold: analysis.costOfGoodsSold,
                operationalExpenses: analysis.operationalExpenses,
                grossProfit: analysis.grossProfit,
                netProfit: analysis.netProfit,
                profitMargin: analysis.profitMargin,
                totalOrders: 1,
                totalPacks: analysis.orderDetails.totalPacks
              }
            });
            processedCount++;
          }
        })
      );
    }

    res.json({
      success: true,
      message: `Profit analysis recalculated for ${processedCount} orders`,
      data: {
        totalOrders: orders.length,
        processedOrders: processedCount,
        dateRange: { startDate, endDate }
      }
    });
  })
);

module.exports = router;