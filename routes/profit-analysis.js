const express = require('express');
const { query, param, body, validationResult } = require('express-validator');

const { asyncHandler, ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = require('../lib/prisma');

// ================================
// COMPREHENSIVE PROFIT CALCULATION
// ================================

const calculateOrderProfitability = async (orderId) => {
  const order = await prisma.distributionOrder.findUnique({
    where: { id: orderId },
    include: {
      orderItems: {
        include: {
          product: true
        }
      },
      transportOrder: true,
      location: true,
      customer: true
    }
  });

  if (!order) return null;

  // Calculate COGS for distribution
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

  const operationalExpenses = expenses.reduce((sum, expense) => 
    sum + parseFloat(expense.amount), 0
  );

  // Transport costs (if linked)
  let transportCosts = 0;
  if (order.transportOrder) {
    transportCosts = parseFloat(order.transportorder.totalTripExpenses || 0);
  }

  // Calculate profit metrics
  const totalRevenue = parseFloat(order.finalAmount);
  const totalCosts = totalCOGS + operationalExpenses + transportCosts;
  const grossProfit = totalRevenue - totalCOGS;
  const netProfit = totalRevenue - totalCosts;
  const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  return {
    orderId,
    totalRevenue,
    costOfGoodsSold: totalCOGS,
    operationalExpenses,
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
  // Get all data for the period
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
        },
        transportOrder: true
      }
    }),
    
    // Get standalone transport orders (not linked to distribution)
    prisma.transportOrder.findMany({
      where: {
        createdAt: { gte: startDate, lte: endDate },
        deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] },
        distributionOrderId: null
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

  // 1. DISTRIBUTION REVENUE & COGS
  let distributionRevenue = 0;
  let distributionCOGS = 0;
  
  for (const order of distributionOrders) {
    distributionRevenue += parseFloat(order.finalAmount);
    
    for (const item of order.orderItems) {
      const itemPacks = (item.pallets * item.product.packsPerPallet) + item.packs;
      distributionCOGS += itemPacks * parseFloat(item.product.costPerPack || 0);
    }
  }

  // 2. TRANSPORT REVENUE (Gross revenue from standalone transport)
  let transportGrossRevenue = 0;
  let transportExpenses = 0;
  
  for (const order of transportOrders) {
    transportGrossRevenue += parseFloat(order.totalOrderAmount);
    transportExpenses += parseFloat(order.totalTripExpenses);
  }
  
  // Transport revenue from distribution-linked orders
  let linkedTransportRevenue = 0;
  let linkedTransportExpenses = 0;
  
  for (const order of distributionOrders) {
    if (order.transportOrder) {
      linkedTransportRevenue += parseFloat(order.transportOrder.totalOrderAmount);
      linkedTransportExpenses += parseFloat(order.transportorder.totalTripExpenses);
    }
  }

  const totalTransportRevenue = transportGrossRevenue + linkedTransportRevenue;
  const totalTransportExpenses = transportExpenses + linkedTransportExpenses;

  // 3. WAREHOUSE REVENUE & COGS
  let warehouseRevenue = 0;
  let warehouseCOGS = 0;
  
  for (const sale of warehouseSales) {
    warehouseRevenue += parseFloat(sale.totalAmount);
    warehouseCOGS += parseFloat(sale.totalCost || 0);
  }

  // 4. OPERATIONAL EXPENSES (excluding transport-related)
  const expenseBreakdown = {};
  let operationalExpenses = 0;

  for (const expense of expenses) {
    const category = expense.category;
    const amount = parseFloat(expense.amount);
    
    expenseBreakdown[category] = (expenseBreakdown[category] || 0) + amount;
    
    // Exclude transport-specific expenses (already counted)
    if (!['FUEL', 'DRIVER_WAGES', 'SERVICE_CHARGES'].includes(category)) {
      operationalExpenses += amount;
    }
  }

  // 5. CONSOLIDATED CALCULATIONS
  const totalRevenue = distributionRevenue + totalTransportRevenue + warehouseRevenue;
  const totalCOGS = distributionCOGS + warehouseCOGS;
  const totalCosts = totalCOGS + totalTransportExpenses + operationalExpenses;
  
  const grossProfit = totalRevenue - totalCOGS;
  const netProfit = totalRevenue - totalCosts;
  const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

  return {
    period,
    startDate,
    endDate,
    revenue: {
      distribution: distributionRevenue,
      transport: totalTransportRevenue,
      warehouse: warehouseRevenue,
      total: totalRevenue
    },
    costs: {
      costOfGoodsSold: totalCOGS,
      distributionCOGS,
      warehouseCOGS,
      transportExpenses: totalTransportExpenses,
      operationalExpenses,
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
      transportTrips: transportOrders.length + distributionOrders.filter(o => o.transportOrder).length,
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

    res.json({
      success: true,
      data: { profitAnalysis }
    });
  })
);

// @route   GET /api/v1/analytics/profit/dashboard
// @desc    Get comprehensive profit dashboard
// @access  Private (Admin)
router.get('/dashboard',
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const { days = 30 } = req.query;
    
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    // Current period analysis
    const currentAnalysis = await generatePeriodAnalysis('current', startDate, endDate);

    // Previous period for comparison
    const prevEndDate = new Date(startDate);
    const prevStartDate = new Date(prevEndDate);
    prevStartDate.setDate(prevStartDate.getDate() - parseInt(days));
    
    const previousAnalysis = await generatePeriodAnalysis('previous', prevStartDate, prevEndDate);

    // Calculate growth metrics
    const revenueGrowth = previousAnalysis.revenue.total > 0 ?
      ((currentAnalysis.revenue.total - previousAnalysis.revenue.total) / previousAnalysis.revenue.total) * 100 : 0;

    const profitGrowth = Math.abs(previousAnalysis.profit.net) > 0 ?
      ((currentAnalysis.profit.net - previousAnalysis.profit.net) / Math.abs(previousAnalysis.profit.net)) * 100 : 0;

    // Get top performers
    const [topLocations, topCustomers] = await Promise.all([
      prisma.$queryRaw`
        SELECT 
          l.id,
          l.name,
          COUNT(DISTINCT do.id) + COUNT(DISTINCT t.id) as total_orders,
          COALESCE(SUM(do.final_amount), 0) + COALESCE(SUM(t.total_order_amount), 0) as total_revenue
        FROM locations l
        LEFT JOIN distribution_orders do ON l.id = do.location_id 
          AND do.created_at >= ${startDate} 
          AND do.created_at <= ${endDate}
        LEFT JOIN transport_orders t ON l.id = t.location_id 
          AND t.created_at >= ${startDate} 
          AND t.created_at <= ${endDate}
          AND t.distribution_order_id IS NULL
        GROUP BY l.id, l.name
        ORDER BY total_revenue DESC
        LIMIT 5
      `,

      prisma.$queryRaw`
        SELECT 
          c.id,
          c.name,
          COUNT(do.id) as order_count,
          SUM(do.final_amount) as total_revenue
        FROM customers c
        JOIN distribution_orders do ON c.id = do.customer_id
        WHERE do.created_at >= ${startDate}
          AND do.created_at <= ${endDate}
        GROUP BY c.id, c.name
        ORDER BY total_revenue DESC
        LIMIT 5
      `
    ]);

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
        kpis: {
          revenuePerDay: currentAnalysis.revenue.total / days,
          profitPerDay: currentAnalysis.profit.net / days,
          avgRevenuePerOrder: currentAnalysis.orderMetrics.distributionOrders > 0 ?
            currentAnalysis.revenue.distribution / currentAnalysis.orderMetrics.distributionOrders : 0,
          costRatio: currentAnalysis.revenue.total > 0 ?
            (currentAnalysis.costs.total / currentAnalysis.revenue.total) * 100 : 0
        },
        topPerformers: {
          locations: topLocations,
          customers: topCustomers
        },
        revenueBreakdown: {
          distribution: {
            amount: currentAnalysis.revenue.distribution,
            percentage: currentAnalysis.revenue.total > 0 ? 
              (currentAnalysis.revenue.distribution / currentAnalysis.revenue.total) * 100 : 0
          },
          transport: {
            amount: currentAnalysis.revenue.transport,
            percentage: currentAnalysis.revenue.total > 0 ? 
              (currentAnalysis.revenue.transport / currentAnalysis.revenue.total) * 100 : 0
          },
          warehouse: {
            amount: currentAnalysis.revenue.warehouse,
            percentage: currentAnalysis.revenue.total > 0 ? 
              (currentAnalysis.revenue.warehouse / currentAnalysis.revenue.total) * 100 : 0
          }
        },
        alerts: {
          lowProfitMargin: currentAnalysis.profit.margin < 10,
          highCostRatio: (currentAnalysis.costs.total / currentAnalysis.revenue.total) * 100 > 80,
          negativeGrowth: revenueGrowth < -5,
          decreasingMargin: currentAnalysis.profit.margin < previousAnalysis.profit.margin
        }
      }
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
    const targetMonth = month ? parseInt(month) - 1 : currentDate.getMonth();

    const startDate = new Date(targetYear, targetMonth, 1);
    const endDate = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);

    const monthlyAnalysis = await generatePeriodAnalysis('monthly', startDate, endDate);

    res.json({
      success: true,
      data: {
        year: targetYear,
        month: targetMonth + 1,
        monthName: startDate.toLocaleString('default', { month: 'long' }),
        analysis: monthlyAnalysis
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
    for (let month = 0; month < 12; month++) {
      const monthStart = new Date(targetYear, month, 1);
      const monthEnd = new Date(targetYear, month + 1, 0, 23, 59, 59);
      
      const monthAnalysis = await generatePeriodAnalysis('monthly', monthStart, monthEnd);
      monthlyBreakdown.push({
        month: month + 1,
        monthName: monthStart.toLocaleString('default', { month: 'long' }),
        ...monthAnalysis
      });
    }

    // Calculate year-over-year comparison
    let yearOverYearComparison = null;
    if (targetYear > 2020) {
      const prevYearStart = new Date(targetYear - 1, 0, 1);
      const prevYearEnd = new Date(targetYear - 1, 11, 31, 23, 59, 59);
      
      const prevYearAnalysis = await generatePeriodAnalysis('yearly', prevYearStart, prevYearEnd);
      
      const revenueGrowth = prevYearAnalysis.revenue.total > 0 ?
        ((yearlyAnalysis.revenue.total - prevYearAnalysis.revenue.total) / prevYearAnalysis.revenue.total) * 100 : 0;
      
      const profitGrowth = Math.abs(prevYearAnalysis.profit.net) > 0 ?
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
          )
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
    const { startDate, endDate, period = '90' } = req.query;

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

    // Get distribution orders for location
    const distributionOrders = await prisma.distributionOrder.findMany({
      where: {
        locationId,
        createdAt: { gte: startDateTime, lte: endDateTime }
      },
      include: {
        orderItems: {
          include: { product: true }
        },
        customer: true,
        transportOrder: true
      }
    });

    // Get standalone transport orders for location
    const transportOrders = await prisma.transportOrder.findMany({
      where: {
        locationId,
        createdAt: { gte: startDateTime, lte: endDateTime },
        distributionOrderId: null,
        deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
      }
    });

    // Calculate metrics
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

    let transportRevenue = 0;
    let transportExpenses = 0;

    for (const order of transportOrders) {
      transportRevenue += parseFloat(order.totalOrderAmount);
      transportExpenses += parseFloat(order.totalTripExpenses);
    }

    // Get expenses for location
    const expenses = await prisma.expense.findMany({
      where: {
        locationId,
        expenseDate: { gte: startDateTime, lte: endDateTime },
        status: 'APPROVED'
      }
    });

    const totalExpenses = expenses.reduce((sum, expense) => sum + parseFloat(expense.amount), 0);

    const totalRevenue = distributionRevenue + transportRevenue;
    const totalCosts = totalCOGS + transportExpenses + totalExpenses;
    const netProfit = totalRevenue - totalCosts;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

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
            transportExpenses,
            operationalExpenses: totalExpenses,
            total: totalCosts
          },
          profit: {
            net: netProfit,
            margin: parseFloat(profitMargin.toFixed(2))
          }
        },
        operationalMetrics: {
          totalOrders: distributionOrders.length,
          totalTransportTrips: transportOrders.length,
          totalPacks,
          revenuePerPack: totalPacks > 0 ? distributionRevenue / totalPacks : 0,
          avgDeliveryValue: transportOrders.length > 0 ? 
            transportOrders.reduce((sum, o) => sum + parseFloat(o.totalOrderAmount), 0) / transportOrders.length : 0
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
        parseFloat(order.transportorder.totalTripExpenses || 0) : 0;

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
    const daysInPeriod = (endDateTime - startDateTime) / (1000 * 60 * 60 * 24);
    const orderFrequency = orders.length / (daysInPeriod / 30); // orders per month
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
          customerLifetimeValue: parseFloat(clv.toFixed(2))
        },
        orderHistory: orderAnalytics,
        insights: {
          mostProfitableOrder: orderAnalytics.reduce((best, current) => 
            current.netProfit > best.netProfit ? current : best, orderAnalytics[0]
          ),
          preferredLocation: orders.length > 0 ? 
            Object.entries(
              orders.reduce((acc, order) => {
                const loc = order.location?.name || 'Unknown';
                acc[loc] = (acc[loc] || 0) + 1;
                return acc;
              }, {})
            ).sort((a, b) => b[1] - a[1])[0]?.[0] : null
        }
      }
    });
  })
);

// @route   POST /api/v1/analytics/profit/recalculate
// @desc    Recalculate profit analysis for all orders
// @access  Private (Super Admin only)
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

    // Process in batches
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