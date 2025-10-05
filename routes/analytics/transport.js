// routes/analytics/transport.js - COMPLETE ANALYTICS

const express = require('express');
const { query, param, validationResult } = require('express-validator');
const prisma = require('../../lib/prisma');

const { asyncHandler, ValidationError, NotFoundError } = require('../../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../../middleware/auth');
const { validateCuid } = require('../../utils/validators');

const router = express.Router();

// All routes require transport module access
router.use(authorizeModule('transport'));

// ================================
// DASHBOARD ANALYTICS
// ================================

// @route   GET /api/v1/analytics/transport/dashboard
// @desc    Get transport dashboard statistics
// @access  Private (Transport module access)
// @route   GET /api/v1/analytics/transport/dashboard
router.get('/dashboard',
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate || endDate) {
      if (startDate) dateFilter.gte = new Date(startDate);
      if (endDate) dateFilter.lte = new Date(endDate);
    }

    const [
      activeTrips,
      totalRevenue,
      totalExpenses,
      recentOrders,
      pendingExpenses,
      trucks
    ] = await Promise.all([
      // ✅ FIXED: Use correct OrderStatus enum values
      prisma.transportOrder.count({
        where: {
          deliveryStatus: { in: ['PENDING', 'IN_TRANSIT'] }, // Changed from CONFIRMED, PROCESSING, IN_TRANSIT
          createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined
        }
      }),

      // ✅ FIXED: Use correct enum values
      prisma.transportOrder.aggregate({
        where: {
          deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] },
          createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined
        },
        _sum: { totalOrderAmount: true, netProfit: true }
      }),

      // ✅ FIXED: Use prisma.expense with TRANSPORT_EXPENSE filter
      prisma.expense.aggregate({
        where: {
          status: 'APPROVED',
          expenseType: 'TRANSPORT_EXPENSE', // Use the correct ExpenseType enum value
          expenseDate: Object.keys(dateFilter).length > 0 ? dateFilter : undefined
        },
        _sum: { amount: true }
      }),

      prisma.transportOrder.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        include: {
          location: { select: { name: true } },
          truck: { select: { registrationNumber: true } }
        }
      }),

      // ✅ FIXED
      prisma.expense.count({
        where: { 
          status: 'PENDING',
          expenseType: 'TRANSPORT_EXPENSE'
        }
      }),

      prisma.truckCapacity.count({
        where: { isActive: true }
      })
    ]);

    const revenue = parseFloat(totalRevenue._sum.totalOrderAmount || 0);
    const profit = parseFloat(totalRevenue._sum.netProfit || 0);
    const expenses = parseFloat(totalExpenses._sum.amount || 0);

    res.json({
      success: true,
      data: {
        activeTrips,
        totalRevenue: revenue,
        totalProfit: profit,
        totalExpenses: expenses,
        fleetSize: trucks,
        pendingExpenses,
        profitMargin: revenue > 0 ? parseFloat(((profit / revenue) * 100).toFixed(2)) : 0,
        recentOrders: recentOrders.map(order => ({
          id: order.id,
          orderNumber: order.orderNumber,
          clientName: order.clientName,
          location: order.location?.name,
          amount: parseFloat(order.totalOrderAmount),
          status: order.deliveryStatus,
          createdAt: order.createdAt
        }))
      }
    });
  })
);

// ================================
// SUMMARY ANALYTICS
// ================================

// @route   GET /api/v1/analytics/transport/summary
// @desc    Get detailed transport analytics summary
// @access  Private (Transport module access)
router.get('/summary',
  asyncHandler(async (req, res) => {
    const { startDate, endDate, truckId } = req.query;

    const dateFilter = {};
    if (startDate || endDate) {
      if (startDate) dateFilter.gte = new Date(startDate);
      if (endDate) dateFilter.lte = new Date(endDate);
    }

    const orderWhere = {
      createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
      deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
    };
    if (truckId) orderWhere.truckId = truckId;

    const [orders, expenses] = await Promise.all([
      prisma.transportOrder.findMany({
        where: orderWhere,
        include: {
          location: { select: { name: true } },
          truck: { select: { truckId: true, registrationNumber: true } }
        }
      }),

      prisma.transportExpense.findMany({
        where: {
          expenseDate: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
          status: 'APPROVED',
          truckId: truckId || undefined
        }
      })
    ]);

    // Calculate metrics
    let totalRevenue = 0;
    let totalTripExpenses = 0;
    let totalFuelCosts = 0;
    let totalDriverWages = 0;
    let totalServiceCharges = 0;
    let totalFuelLiters = 0;

    const clientStats = {};
    const truckStats = {};
    const locationStats = {};

    orders.forEach(order => {
      const revenue = parseFloat(order.totalOrderAmount);
      const tripExpenses = parseFloat(order.totalTripExpenses);
      const fuel = parseFloat(order.totalFuelCost);
      const wages = parseFloat(order.driverWages || 0) + parseFloat(order.tripAllowance || 0) + parseFloat(order.motorBoyWages || 0);
      const service = parseFloat(order.serviceChargeExpenseExpense);

      totalRevenue += revenue;
      totalTripExpenses += tripExpenses;
      totalFuelCosts += fuel;
      totalDriverWages += wages;
      totalServiceCharges += service;
      totalFuelLiters += parseFloat(order.fuelRequired);

      // Client statistics
      const clientName = order.clientName;
      if (!clientStats[clientName]) {
        clientStats[clientName] = { trips: 0, revenue: 0, profit: 0 };
      }
      clientStats[clientName].trips += 1;
      clientStats[clientName].revenue += revenue;
      clientStats[clientName].profit += parseFloat(order.netProfit);

      // Truck statistics
      if (order.truck) {
        const truckKey = order.truck.registrationNumber || order.truck.truckId;
        if (!truckStats[truckKey]) {
          truckStats[truckKey] = { trips: 0, revenue: 0, fuelUsed: 0, profit: 0 };
        }
        truckStats[truckKey].trips += 1;
        truckStats[truckKey].revenue += revenue;
        truckStats[truckKey].fuelUsed += parseFloat(order.fuelRequired);
        truckStats[truckKey].profit += parseFloat(order.netProfit);
      }

      // Location statistics
      if (order.location) {
        const locationName = order.location.name;
        if (!locationStats[locationName]) {
          locationStats[locationName] = { trips: 0, revenue: 0 };
        }
        locationStats[locationName].trips += 1;
        locationStats[locationName].revenue += revenue;
      }
    });

    // Calculate non-trip expenses
    const totalNonTripExpenses = expenses.reduce(
      (sum, expense) => sum + parseFloat(expense.amount), 0
    );

    // Group expenses by category
    const expensesByCategory = expenses.reduce((acc, expense) => {
      const category = expense.category;
      if (!acc[category]) acc[category] = 0;
      acc[category] += parseFloat(expense.amount);
      return acc;
    }, {});

    // Calculate profitability
    const totalAllExpenses = totalTripExpenses + totalNonTripExpenses;
    const grossProfit = totalRevenue - totalTripExpenses;
    const netProfit = totalRevenue - totalAllExpenses;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
    const averageTripRevenue = orders.length > 0 ? totalRevenue / orders.length : 0;

    // Top performers
    const topClients = Object.entries(clientStats)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 5)
      .map(([name, stats]) => ({ name, ...stats }));

    const topTrucks = Object.entries(truckStats)
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, 5)
      .map(([truck, stats]) => ({ truck, ...stats }));

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          tripExpenses: {
            fuel: parseFloat(totalFuelCosts.toFixed(2)),
            wages: parseFloat(totalDriverWages.toFixed(2)),
            serviceCharges: parseFloat(totalServiceCharges.toFixed(2)),
            total: parseFloat(totalTripExpenses.toFixed(2))
          },
          nonTripExpenses: parseFloat(totalNonTripExpenses.toFixed(2)),
          totalExpenses: parseFloat(totalAllExpenses.toFixed(2)),
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          netProfit: parseFloat(netProfit.toFixed(2)),
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          totalTrips: orders.length,
          averageTripRevenue: parseFloat(averageTripRevenue.toFixed(2)),
          totalFuelLiters: parseFloat(totalFuelLiters.toFixed(2))
        },
        breakdown: {
          byClient: topClients,
          byTruck: topTrucks,
          byLocation: Object.entries(locationStats).map(([name, stats]) => ({ name, ...stats })),
          expensesByCategory
        },
        period: { startDate, endDate }
      }
    });
  })
);

// ================================
// PROFIT ANALYSIS
// ================================

// @route   GET /api/v1/analytics/transport/profit-analysis
// @desc    Get detailed profit analysis
// @access  Private (Admin)
router.get('/profit-analysis',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  asyncHandler(async (req, res) => {
    const { startDate, endDate, locationId } = req.query;

    const where = {
      deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
    };

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    if (locationId) where.locationId = locationId;

    const [orders, summary] = await Promise.all([
      prisma.transportOrder.findMany({
        where,
        include: {
          location: true,
          truck: true
        },
        orderBy: { createdAt: 'desc' },
        take: 50
      }),

      prisma.transportOrder.aggregate({
        where,
        _sum: {
          totalOrderAmount: true,
          totalTripExpenses: true,
          totalFuelCost: true,
          driverWages: true,
          serviceChargeExpense: true,
          grossProfit: true,
          netProfit: true
        },
        _avg: { profitMargin: true },
        _count: true
      })
    ]);

    // Group by location
    const locationBreakdown = await prisma.transportOrder.groupBy({
      by: ['locationId'],
      where,
      _sum: {
        totalOrderAmount: true,
        netProfit: true
      },
      _count: true
    });

    // Enhance with location names
    const locationDetails = await Promise.all(
      locationBreakdown.map(async (item) => {
        const location = await prisma.location.findUnique({
          where: { id: item.locationId },
          select: { name: true }
        });
        return {
          location: location?.name || 'Unknown',
          trips: item._count,
          revenue: parseFloat(item._sum.totalOrderAmount || 0),
          profit: parseFloat(item._sum.netProfit || 0)
        };
      })
    );

    // Group by month
    const monthlyTrend = await prisma.$queryRaw`
      SELECT 
        DATE_TRUNC('month', created_at) as month,
        COUNT(*) as trips,
        SUM(total_order_amount) as revenue,
        SUM(net_profit) as profit,
        AVG(profit_margin) as avg_margin
      FROM transport_orders
      WHERE delivery_status IN ('DELIVERED', 'PARTIALLY_DELIVERED')
        ${startDate ? prisma.Prisma.sql`AND created_at >= ${new Date(startDate)}` : prisma.Prisma.empty}
        ${endDate ? prisma.Prisma.sql`AND created_at <= ${new Date(endDate)}` : prisma.Prisma.empty}
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month DESC
      LIMIT 12
    `;

    res.json({
      success: true,
      data: {
        summary: {
          totalTrips: summary._count,
          totalRevenue: parseFloat(summary._sum.totalOrderAmount || 0),
          totalExpenses: parseFloat(summary._sum.totalTripExpenses || 0),
          totalProfit: parseFloat(summary._sum.netProfit || 0),
          averageMargin: parseFloat(summary._avg.profitMargin || 0),
          breakdown: {
            fuel: parseFloat(summary._sum.totalFuelCost || 0),
            wages: parseFloat(summary._sum.driverWages || 0),
            serviceCharges: parseFloat(summary._sum.serviceChargeExpense || 0)
          }
        },
        byLocation: locationDetails,
        monthlyTrend: monthlyTrend.map(row => ({
          month: row.month,
          trips: parseInt(row.trips),
          revenue: parseFloat(row.revenue || 0),
          profit: parseFloat(row.profit || 0),
          avgMargin: parseFloat(row.avg_margin || 0)
        })),
        recentOrders: orders.slice(0, 20).map(order => ({
          id: order.id,
          orderNumber: order.orderNumber,
          client: order.clientName,
          location: order.location?.name,
          revenue: parseFloat(order.totalOrderAmount),
          expenses: parseFloat(order.totalTripExpenses),
          profit: parseFloat(order.netProfit),
          margin: parseFloat(order.profitMargin),
          date: order.createdAt
        }))
      }
    });
  })
);

// ================================
// TRUCK PERFORMANCE
// ================================

// @route   GET /api/v1/analytics/transport/trucks/:truckId/performance
// @desc    Get truck performance metrics
// @access  Private (Transport module access)
router.get('/trucks/:truckId/performance',
  param('truckId').notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { truckId } = req.params;
    const { startDate, endDate } = req.query;

    const truck = await prisma.truckCapacity.findUnique({
      where: { truckId }
    });

    if (!truck) {
      throw new NotFoundError('Truck not found');
    }

    const dateFilter = {};
    if (startDate || endDate) {
      if (startDate) dateFilter.gte = new Date(startDate);
      if (endDate) dateFilter.lte = new Date(endDate);
    }

    const [trips, expenses] = await Promise.all([
      prisma.transportOrder.findMany({
        where: {
          truckId,
          createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
          deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
        },
        include: {
          location: { select: { name: true } }
        },
        orderBy: { createdAt: 'desc' }
      }),

      prisma.transportExpense.findMany({
        where: {
          truckId,
          expenseDate: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
          status: 'APPROVED'
        },
        orderBy: { expenseDate: 'desc' }
      })
    ]);

    // Calculate metrics
    const totalRevenue = trips.reduce((sum, trip) => sum + parseFloat(trip.totalOrderAmount), 0);
    const totalTripExpenses = trips.reduce((sum, trip) => sum + parseFloat(trip.totalTripExpenses), 0);
    const totalMaintenanceExpenses = expenses.reduce((sum, exp) => sum + parseFloat(exp.amount), 0);
    const totalFuelUsed = trips.reduce((sum, trip) => sum + parseFloat(trip.fuelRequired), 0);
    const totalFuelCost = trips.reduce((sum, trip) => sum + parseFloat(trip.totalFuelCost), 0);

    const netProfit = totalRevenue - totalTripExpenses - totalMaintenanceExpenses;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
    const avgRevenuePerTrip = trips.length > 0 ? totalRevenue / trips.length : 0;
    const avgFuelPerTrip = trips.length > 0 ? totalFuelUsed / trips.length : 0;

    // Monthly breakdown
    const monthlyStats = {};
    trips.forEach(trip => {
      const month = new Date(trip.createdAt).toISOString().slice(0, 7);
      if (!monthlyStats[month]) {
        monthlyStats[month] = { trips: 0, revenue: 0, fuelUsed: 0 };
      }
      monthlyStats[month].trips += 1;
      monthlyStats[month].revenue += parseFloat(trip.totalOrderAmount);
      monthlyStats[month].fuelUsed += parseFloat(trip.fuelRequired);
    });

    res.json({
      success: true,
      data: {
        truck: {
          truckId: truck.truckId,
          registrationNumber: truck.registrationNumber,
          make: truck.make,
          model: truck.model,
          maxPallets: truck.maxPallets
        },
        performance: {
          totalTrips: trips.length,
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalTripExpenses: parseFloat(totalTripExpenses.toFixed(2)),
          totalMaintenanceExpenses: parseFloat(totalMaintenanceExpenses.toFixed(2)),
          totalExpenses: parseFloat((totalTripExpenses + totalMaintenanceExpenses).toFixed(2)),
          netProfit: parseFloat(netProfit.toFixed(2)),
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          totalFuelUsed: parseFloat(totalFuelUsed.toFixed(2)),
          totalFuelCost: parseFloat(totalFuelCost.toFixed(2)),
          averageRevenuePerTrip: parseFloat(avgRevenuePerTrip.toFixed(2)),
          averageFuelPerTrip: parseFloat(avgFuelPerTrip.toFixed(2))
        },
        monthlyBreakdown: Object.entries(monthlyStats).map(([month, stats]) => ({
          month,
          ...stats
        })),
        recentTrips: trips.slice(0, 10).map(trip => ({
          id: trip.id,
          orderNumber: trip.orderNumber,
          client: trip.clientName,
          location: trip.location?.name,
          revenue: parseFloat(trip.totalOrderAmount),
          profit: parseFloat(trip.netProfit),
          fuelUsed: parseFloat(trip.fuelRequired),
          date: trip.createdAt
        })),
        recentExpenses: expenses.slice(0, 10).map(exp => ({
          id: exp.id,
          category: exp.category,
          amount: parseFloat(exp.amount),
          description: exp.description,
          date: exp.expenseDate
        })),
        period: { startDate, endDate }
      }
    });
  })
);

// ================================
// CLIENT ANALYTICS
// ================================

// @route   GET /api/v1/analytics/transport/clients
// @desc    Get client profitability statistics
// @access  Private (Transport module access)
router.get('/clients',
  asyncHandler(async (req, res) => {
    const { startDate, endDate, limit = 20 } = req.query;

    const dateFilter = {};
    if (startDate || endDate) {
      if (startDate) dateFilter.gte = new Date(startDate);
      if (endDate) dateFilter.lte = new Date(endDate);
    }

    const orders = await prisma.transportOrder.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
        deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
      },
      select: {
        clientName: true,
        totalOrderAmount: true,
        netProfit: true,
        createdAt: true
      }
    });

    // Aggregate by client
    const clientStats = {};
    orders.forEach(order => {
      const client = order.clientName;
      if (!clientStats[client]) {
        clientStats[client] = {
          totalTrips: 0,
          totalRevenue: 0,
          totalProfit: 0,
          lastTrip: null
        };
      }
      clientStats[client].totalTrips += 1;
      clientStats[client].totalRevenue += parseFloat(order.totalOrderAmount);
      clientStats[client].totalProfit += parseFloat(order.netProfit);
      
      if (!clientStats[client].lastTrip || new Date(order.createdAt) > new Date(clientStats[client].lastTrip)) {
        clientStats[client].lastTrip = order.createdAt;
      }
    });

    // Convert to array and calculate metrics
    const clientList = Object.entries(clientStats).map(([name, stats]) => ({
      clientName: name,
      totalTrips: stats.totalTrips,
      totalRevenue: parseFloat(stats.totalRevenue.toFixed(2)),
      totalProfit: parseFloat(stats.totalProfit.toFixed(2)),
      averageRevenuePerTrip: parseFloat((stats.totalRevenue / stats.totalTrips).toFixed(2)),
      profitMargin: stats.totalRevenue > 0 ? parseFloat(((stats.totalProfit / stats.totalRevenue) * 100).toFixed(2)) : 0,
      lastTrip: stats.lastTrip
    }));

    // Sort by total revenue
    clientList.sort((a, b) => b.totalRevenue - a.totalRevenue);

    res.json({
      success: true,
      data: {
        clients: clientList.slice(0, parseInt(limit)),
        summary: {
          totalClients: clientList.length,
          totalRevenue: parseFloat(clientList.reduce((sum, c) => sum + c.totalRevenue, 0).toFixed(2)),
          totalProfit: parseFloat(clientList.reduce((sum, c) => sum + c.totalProfit, 0).toFixed(2))
        },
        period: { startDate, endDate }
      }
    });
  })
);

// ================================
// EXPENSE ANALYTICS
// ================================

// @route   GET /api/v1/analytics/transport/expenses/summary
// @desc    Get expense analytics summary
// @access  Private (Admin)
router.get('/expenses/summary',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    const where = { status: 'APPROVED' };

    if (startDate || endDate) {
      where.expenseDate = {};
      if (startDate) where.expenseDate.gte = new Date(startDate);
      if (endDate) where.expenseDate.lte = new Date(endDate);
    }

    const [summary, byCategory, byType, byTruck] = await Promise.all([
      // Total summary
      prisma.transportExpense.aggregate({
        where,
        _sum: { amount: true },
        _count: true,
        _avg: { amount: true }
      }),

      // By category
      prisma.transportExpense.groupBy({
        by: ['category'],
        where,
        _sum: { amount: true },
        _count: true
      }),

      // By type
      prisma.transportExpense.groupBy({
        by: ['expenseType'],
        where,
        _sum: { amount: true },
        _count: true
      }),

      // By truck
      prisma.transportExpense.groupBy({
        by: ['truckId'],
        where: { ...where, truckId: { not: null } },
        _sum: { amount: true },
        _count: true
      })
    ]);

    res.json({
      success: true,
      data: {
        summary: {
          totalAmount: parseFloat(summary._sum.amount || 0),
          totalCount: summary._count,
          averageAmount: parseFloat(summary._avg.amount || 0)
        },
        byCategory: byCategory.map(item => ({
          category: item.category,
          amount: parseFloat(item._sum.amount || 0),
          count: item._count
        })),
        byType: byType.map(item => ({
          type: item.expenseType,
          amount: parseFloat(item._sum.amount || 0),
          count: item._count
        })),
        byTruck: byTruck.slice(0, 10).map(item => ({
          truckId: item.truckId,
          amount: parseFloat(item._sum.amount || 0),
          count: item._count
        })),
        period: { startDate, endDate }
      }
    });
  })
);

module.exports = router;