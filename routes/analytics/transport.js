// routes/analytics/transport.js - Transport-only analytics

const express = require('express');
const { query, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError } = require('../../middleware/errorHandler');
const { authorizeModule } = require('../../middleware/auth');
const { authorizeRole } = require('../../middleware/auth'); // Import authorizeRole

const router = express.Router();
const prisma = new PrismaClient();

router.get('/dashboard',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  asyncHandler(async (req, res) => {
    try {
      const orders = await prisma.transportOrder.findMany({
        include: { truck: true }
      });

      const activeTrips = orders.filter(order => order.status === 'IN_TRANSIT').length;
      const totalRevenue = orders.reduce((sum, order) => sum + order.totalOrderAmount, 0);
      const completedTrips = orders.filter(order => order.status === 'DELIVERED').length;

      res.json({
        success: true,
        data: {
          activeTrips,
          totalRevenue,
          completedTrips,
          totalOrders: orders.length,
          recentOrders: orders.slice(0, 10).map(order => ({
            id: order.id,
            orderNumber: order.orderNumber,
            clientName: order.clientName,
            status: order.status,
            totalAmount: order.totalOrderAmount,
            createdAt: order.createdAt
          }))
        }
      });
    } catch (error) {
      console.error('Transport dashboard error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: 'Failed to fetch transport dashboard data'
      });
    }
  })
);

// Get transport analytics summary
router.get('/summary',
  authorizeModule('transport'),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('truckId').optional()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { startDate, endDate, truckId } = req.query;
    
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    const orderWhere = {
      createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
      deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
    };
    if (truckId) orderWhere.truckId = truckId;

    // Get transport orders and expenses
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

    // Calculate trip metrics
    let totalRevenue = 0;
    let totalTripExpenses = 0;
    let totalFuelCosts = 0;
    let totalDriverWages = 0;
    let totalServiceCharges = 0;
    let totalFuelLiters = 0;
    let totalKilometers = 0;

    const clientStats = {};
    const truckStats = {};

    orders.forEach(order => {
      const revenue = parseFloat(order.totalOrderAmount);
      const tripExpenses = parseFloat(order.totalTripExpenses);
      const fuel = parseFloat(order.totalFuelCost);
      const wages = parseFloat(order.driverWages);
      const service = parseFloat(order.serviceChargeExpense);

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
          truckStats[truckKey] = { trips: 0, revenue: 0, fuelUsed: 0 };
        }
        truckStats[truckKey].trips += 1;
        truckStats[truckKey].revenue += revenue;
        truckStats[truckKey].fuelUsed += parseFloat(order.fuelRequired);
      }
    });

    // Calculate non-trip expenses
    const totalNonTripExpenses = expenses.reduce(
      (sum, expense) => sum + parseFloat(expense.amount), 0
    );

    // Group expenses by type
    const expensesByType = expenses.reduce((acc, expense) => {
      const type = expense.expenseType;
      if (!acc[type]) acc[type] = 0;
      acc[type] += parseFloat(expense.amount);
      return acc;
    }, {});

    // Calculate profitability
    const totalAllExpenses = totalTripExpenses + totalNonTripExpenses;
    const grossProfit = totalRevenue - totalTripExpenses; // Revenue - Trip costs
    const netProfit = totalRevenue - totalAllExpenses; // Revenue - All costs
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;
    const averageTripRevenue = orders.length > 0 ? totalRevenue / orders.length : 0;

    // Top clients and trucks
    const topClients = Object.entries(clientStats)
      .map(([name, stats]) => ({ clientName: name, ...stats }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const topTrucks = Object.entries(truckStats)
      .map(([truck, stats]) => ({ truck, ...stats }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          tripExpenses: {
            fuel: parseFloat(totalFuelCosts.toFixed(2)),
            driverWages: parseFloat(totalDriverWages.toFixed(2)),
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
          totalFuelUsed: parseFloat(totalFuelLiters.toFixed(2))
        },
        expenseBreakdown: expensesByType,
        topClients,
        topTrucks,
        period: { startDate, endDate }
      }
    });
  })
);

// Get truck performance analytics
router.get('/trucks/:truckId/performance',
  authorizeModule('transport'),
  asyncHandler(async (req, res) => {
    const { truckId } = req.params;
    const { startDate, endDate } = req.query;

    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    // Get truck details
    const truck = await prisma.truckCapacity.findUnique({
      where: { truckId }
    });

    if (!truck) {
      return res.status(404).json({
        success: false,
        message: 'Truck not found'
      });
    }

    // Get trips and expenses for this truck
    const [trips, expenses] = await Promise.all([
      prisma.transportOrder.findMany({
        where: {
          truckId,
          createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
          deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
        }
      }),
      
      prisma.transportExpense.findMany({
        where: {
          truckId,
          expenseDate: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
          status: 'APPROVED'
        }
      })
    ]);

    // Calculate metrics
    const totalRevenue = trips.reduce((sum, trip) => sum + parseFloat(trip.totalOrderAmount), 0);
    const totalTripExpenses = trips.reduce((sum, trip) => sum + parseFloat(trip.totalTripExpenses), 0);
    const totalMaintenanceExpenses = expenses.reduce((sum, exp) => sum + parseFloat(exp.amount), 0);
    const totalFuelUsed = trips.reduce((sum, trip) => sum + parseFloat(trip.fuelRequired), 0);

    const netProfit = totalRevenue - totalTripExpenses - totalMaintenanceExpenses;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    res.json({
      success: true,
      data: {
        truck: {
          truckId: truck.truckId,
          registrationNumber: truck.registrationNumber,
          make: truck.make,
          model: truck.model
        },
        performance: {
          totalTrips: trips.length,
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalTripExpenses: parseFloat(totalTripExpenses.toFixed(2)),
          totalMaintenanceExpenses: parseFloat(totalMaintenanceExpenses.toFixed(2)),
          netProfit: parseFloat(netProfit.toFixed(2)),
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          totalFuelUsed: parseFloat(totalFuelUsed.toFixed(2)),
          averageRevenuePerTrip: trips.length > 0 ? parseFloat((totalRevenue / trips.length).toFixed(2)) : 0
        },
        recentTrips: trips.slice(-5),
        recentExpenses: expenses.slice(-5),
        period: { startDate, endDate }
      }
    });
  })
);

module.exports = router;