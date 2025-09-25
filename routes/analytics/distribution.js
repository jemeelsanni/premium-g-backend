// routes/analytics/distribution.js - Distribution-only analytics

const express = require('express');
const { query, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError } = require('../../middleware/errorHandler');
const { authorizeModule } = require('../../middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// Get distribution analytics summary
router.get('/summary',
  authorizeModule('distribution'),
  [
    query('startDate').optional().isISO8601().withMessage('Invalid start date'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date'),
    query('period').optional().isIn(['daily', 'weekly', 'monthly', 'yearly'])
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { startDate, endDate, period = 'monthly' } = req.query;
    
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    // Get distribution orders only
    const orders = await prisma.distributionOrder.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
        status: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
      },
      include: {
        orderItems: { include: { product: true } },
        customer: { select: { name: true } },
        location: { select: { name: true } }
      }
    });

    // Calculate pure distribution metrics
    let totalRevenue = 0;
    let totalCOGS = 0;
    let totalPacks = 0;
    let totalPallets = 0;
    const customerStats = {};
    const locationStats = {};

    for (const order of orders) {
      const orderRevenue = parseFloat(order.finalAmount);
      totalRevenue += orderRevenue;
      totalPacks += order.totalPacks;
      totalPallets += order.totalPallets;
      
      // Customer analytics
      const customerName = order.customer?.name || 'Unknown';
      if (!customerStats[customerName]) {
        customerStats[customerName] = { orders: 0, revenue: 0, packs: 0 };
      }
      customerStats[customerName].orders += 1;
      customerStats[customerName].revenue += orderRevenue;
      customerStats[customerName].packs += order.totalPacks;

      // Location analytics
      const locationName = order.location?.name || 'Unknown';
      if (!locationStats[locationName]) {
        locationStats[locationName] = { orders: 0, revenue: 0, packs: 0 };
      }
      locationStats[locationName].orders += 1;
      locationStats[locationName].revenue += orderRevenue;
      locationStats[locationName].packs += order.totalPacks;
      
      // Calculate COGS for this order
      for (const item of order.orderItems) {
        const itemPacks = (item.pallets * item.product.packsPerPallet) + item.packs;
        totalCOGS += itemPacks * parseFloat(item.product.costPerPack || 0);
      }
    }

    const grossProfit = totalRevenue - totalCOGS;
    const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const averageOrderValue = orders.length > 0 ? totalRevenue / orders.length : 0;

    // Get top customers and locations
    const topCustomers = Object.entries(customerStats)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    const topLocations = Object.entries(locationStats)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5);

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalCOGS: parseFloat(totalCOGS.toFixed(2)),
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          totalOrders: orders.length,
          totalPacks,
          totalPallets,
          averageOrderValue: parseFloat(averageOrderValue.toFixed(2))
        },
        topCustomers,
        topLocations,
        period: { startDate, endDate }
      }
    });
  })
);

// Get distribution target performance
router.get('/targets',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const { year, month } = req.query;
    const currentDate = new Date();
    const targetYear = year ? parseInt(year) : currentDate.getFullYear();
    const targetMonth = month ? parseInt(month) : currentDate.getMonth() + 1;

    const target = await prisma.distributionTarget.findUnique({
      where: { 
        year_month: { 
          year: targetYear, 
          month: targetMonth 
        } 
      },
      include: {
        weeklyPerformances: {
          orderBy: { weekNumber: 'asc' }
        }
      }
    });

    if (!target) {
      return res.json({
        success: true,
        data: { message: 'No target set for specified month' }
      });
    }

    const totalActual = target.weeklyPerformances.reduce(
      (sum, week) => sum + week.actualPacks, 0
    );
    const overallPercentage = target.totalPacksTarget > 0 ? 
      (totalActual / target.totalPacksTarget) * 100 : 0;

    res.json({
      success: true,
      data: {
        target,
        performance: {
          totalTarget: target.totalPacksTarget,
          totalActual,
          percentageAchieved: parseFloat(overallPercentage.toFixed(2)),
          remainingTarget: target.totalPacksTarget - totalActual,
          weeklyBreakdown: target.weeklyPerformances
        }
      }
    });
  })
);

module.exports = router;