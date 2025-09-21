const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// MIDDLEWARE - Transport Module Access
// ================================

// All transport routes require transport module access
router.use(authorizeModule('transport'));

// ================================
// VALIDATION RULES
// ================================

const createTransportOrderValidation = [
  body('orderNumber')
    .notEmpty()
    .withMessage('Order number is required')
    .isLength({ max: 50 })
    .withMessage('Order number must not exceed 50 characters'),
  body('locationId')
    .notEmpty()
    .withMessage('Location ID is required')
    .custom(validateCuid('location ID')),
  body('totalOrderAmount')
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Total order amount must be a valid decimal'),
  body('fuelRequired')
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Fuel required must be a valid decimal'),
  body('fuelPricePerLiter')
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Fuel price per liter must be a valid decimal'),
  body('truckId')
    .optional()
    .isLength({ max: 20 })
    .withMessage('Truck ID must not exceed 20 characters'),
  body('driverDetails')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Driver details must not exceed 200 characters')
];

// ================================
// ENHANCED BUSINESS LOGIC FUNCTIONS
// ================================

const calculateTransportCosts = async (totalOrderAmount, fuelRequired, fuelPricePerLiter, locationId) => {
  // Get location details for driver wages
  const location = await prisma.location.findUnique({
    where: { id: locationId }
  });

  if (!location) {
    throw new NotFoundError('Location not found');
  }

  const totalFuelCost = parseFloat((fuelRequired * fuelPricePerLiter).toFixed(2));
  const serviceChargeExpense = parseFloat((totalOrderAmount * 0.10).toFixed(2)); // 10% service charge - THIS IS AN EXPENSE
  const driverWages = parseFloat(location.driverWagesPerTrip.toString());
  
  // Calculate total expenses
  const totalExpenses = totalFuelCost + serviceChargeExpense + driverWages;
  
  // Calculate net profit (Revenue - All Expenses)
  const netProfit = totalOrderAmount - totalExpenses;
  const profitMargin = totalOrderAmount > 0 ? (netProfit / totalOrderAmount) * 100 : 0;
  
  return {
    totalFuelCost,
    serviceChargeExpense, // Correctly categorized as expense
    driverWages,
    totalExpenses,
    netProfit: parseFloat(netProfit.toFixed(2)),
    profitMargin: parseFloat(profitMargin.toFixed(2))
  };
};

const createProfitAnalysis = async (transportOrder, type = 'TRANSPORT_TRIP') => {
  return await prisma.profitAnalysis.create({
    data: {
      analysisType: type,
      referenceId: transportOrder.id,
      totalRevenue: transportOrder.totalOrderAmount,
      transportRevenue: transportOrder.totalOrderAmount,
      totalCosts: transportOrder.totalExpenses,
      fuelCosts: transportOrder.totalFuelCost,
      driverWages: transportOrder.driverWages,
      serviceCharges: transportOrder.serviceChargeExpense,
      grossProfit: transportOrder.netProfit,
      netProfit: transportOrder.netProfit,
      profitMargin: transportOrder.profitMargin,
      totalOrders: 1
    }
  });
};

// ================================
// ROUTES - TRANSPORT ORDERS
// ================================

// @route   POST /api/v1/transport/orders
// @desc    Create new transport order with proper cost structure
// @access  Private (Transport Staff, Admin)
router.post('/orders',
  authorizeModule('transport', 'write'),
  createTransportOrderValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      distributionOrderId,
      orderNumber,
      invoiceNumber,
      locationId,
      truckId,
      totalOrderAmount,
      fuelRequired,
      fuelPricePerLiter,
      driverDetails
    } = req.body;

    const userId = req.user.id;

    // Check if order number already exists
    const existingOrder = await prisma.transportOrder.findUnique({
      where: { orderNumber }
    });

    if (existingOrder) {
      throw new BusinessError('Order number already exists', 'ORDER_NUMBER_EXISTS');
    }

    // Calculate enhanced costs with proper profit structure
    const costCalculation = await calculateTransportCosts(
      parseFloat(totalOrderAmount),
      parseFloat(fuelRequired),
      parseFloat(fuelPricePerLiter),
      locationId
    );

    // Create transport order with transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create transport order
      const transportOrder = await tx.transportOrder.create({
        data: {
          distributionOrderId: distributionOrderId || null,
          orderNumber,
          invoiceNumber,
          locationId,
          truckId,
          totalOrderAmount: parseFloat(totalOrderAmount),
          fuelRequired: parseFloat(fuelRequired),
          fuelPricePerLiter: parseFloat(fuelPricePerLiter),
          totalFuelCost: costCalculation.totalFuelCost,
          serviceChargeExpense: costCalculation.serviceChargeExpense, // Expense, not revenue
          driverWages: costCalculation.driverWages,
          totalExpenses: costCalculation.totalExpenses,
          netProfit: costCalculation.netProfit,
          profitMargin: costCalculation.profitMargin,
          driverDetails,
          createdBy: userId
        },
        include: {
          location: true,
          truck: true,
          distributionOrder: {
            include: {
              customer: true
            }
          }
        }
      });

      // Create profit analysis record
      await createProfitAnalysis(transportOrder);

      // Create expense records for tracking
      const expenseRecords = [
        {
          expenseType: 'FUEL_COST',
          category: 'FUEL',
          amount: costCalculation.totalFuelCost,
          description: `Fuel cost for transport order ${orderNumber}`,
          referenceId: transportOrder.id,
          locationId,
          truckId,
          expenseDate: new Date(),
          status: 'APPROVED',
          createdBy: userId,
          approvedBy: userId,
          approvedAt: new Date()
        },
        {
          expenseType: 'SERVICE_CHARGE',
          category: 'TRANSPORT_SERVICE_FEE',
          amount: costCalculation.serviceChargeExpense,
          description: `Transport service charge (10%) for order ${orderNumber}`,
          referenceId: transportOrder.id,
          locationId,
          expenseDate: new Date(),
          status: 'APPROVED',
          createdBy: userId,
          approvedBy: userId,
          approvedAt: new Date()
        },
        {
          expenseType: 'SALARY_WAGES',
          category: 'DRIVER_WAGES',
          amount: costCalculation.driverWages,
          description: `Driver wages for trip to ${transportOrder.location.name}`,
          referenceId: transportOrder.id,
          locationId,
          truckId,
          expenseDate: new Date(),
          status: 'APPROVED',
          createdBy: userId,
          approvedBy: userId,
          approvedAt: new Date()
        }
      ];

      // Create expense records
      for (const expense of expenseRecords) {
        await tx.expense.create({ data: expense });
      }

      return transportOrder;
    });

    res.status(201).json({
      success: true,
      message: 'Transport order created successfully',
      data: { 
        transportOrder: result,
        costBreakdown: {
          revenue: parseFloat(totalOrderAmount),
          expenses: {
            fuel: costCalculation.totalFuelCost,
            serviceCharge: costCalculation.serviceChargeExpense,
            driverWages: costCalculation.driverWages,
            total: costCalculation.totalExpenses
          },
          profit: {
            net: costCalculation.netProfit,
            margin: `${costCalculation.profitMargin}%`
          }
        }
      }
    });
  })
);

// @route   GET /api/v1/transport/orders
// @desc    Get transport orders with enhanced profit metrics
// @access  Private (Transport module access)
router.get('/orders', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    deliveryStatus,
    locationId,
    truckId,
    startDate,
    endDate,
    search,
    includeProfitAnalysis = false
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  // Build where clause
  const where = {};

  // Role-based filtering - non-admins see only their own orders
  if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
    where.createdBy = req.user.id;
  }

  if (deliveryStatus) where.deliveryStatus = deliveryStatus;
  if (locationId) where.locationId = locationId;
  if (truckId) where.truckId = truckId;

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  if (search) {
    where.OR = [
      { orderNumber: { contains: search, mode: 'insensitive' } },
      { invoiceNumber: { contains: search, mode: 'insensitive' } },
      { driverDetails: { contains: search, mode: 'insensitive' } }
    ];
  }

  const includeClause = {
    location: true,
    truck: true,
    distributionOrder: {
      include: {
        customer: true
      }
    },
    createdByUser: {
      select: { username: true, role: true }
    }
  };

  if (includeProfitAnalysis === 'true') {
    includeClause.profitAnalysis = {
      where: { analysisType: 'TRANSPORT_TRIP' },
      take: 1
    };
  }

  const [orders, total] = await Promise.all([
    prisma.transportOrder.findMany({
      where,
      include: includeClause,
      orderBy: { createdAt: 'desc' },
      skip,
      take
    }),
    prisma.transportOrder.count({ where })
  ]);

  // Add summary statistics
  const summary = await prisma.transportOrder.aggregate({
    where,
    _sum: {
      totalOrderAmount: true,
      totalExpenses: true,
      netProfit: true
    },
    _avg: {
      profitMargin: true
    }
  });

  res.json({
    success: true,
    data: {
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      },
      summary: {
        totalRevenue: summary._sum.totalOrderAmount || 0,
        totalExpenses: summary._sum.totalExpenses || 0,
        totalProfit: summary._sum.netProfit || 0,
        averageProfitMargin: summary._avg.profitMargin || 0
      }
    }
  });
}));

// @route   GET /api/v1/transport/orders/:id
// @desc    Get single transport order with detailed cost breakdown
// @access  Private (Transport module access)
router.get('/orders/:id',
  param('id').custom(validateCuid('order ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const where = { id };

    // Role-based access - non-admins can only see their own orders
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.createdBy = req.user.id;
    }

    const order = await prisma.transportOrder.findFirst({
      where,
      include: {
        location: true,
        truck: true,
        distributionOrder: {
          include: {
            customer: true,
            orderItems: {
              include: {
                product: true
              }
            }
          }
        },
        createdByUser: {
          select: { username: true, role: true }
        },
        profitAnalysis: {
          where: { analysisType: 'TRANSPORT_TRIP' }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Transport order not found');
    }

    // Get related expenses
    const expenses = await prisma.expense.findMany({
      where: { referenceId: order.id },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: { 
        order,
        expenses,
        costBreakdown: {
          revenue: {
            total: order.totalOrderAmount
          },
          expenses: {
            fuel: order.totalFuelCost,
            serviceCharge: order.serviceChargeExpense,
            driverWages: order.driverWages,
            truckExpenses: order.truckExpenses,
            total: order.totalExpenses
          },
          profit: {
            net: order.netProfit,
            margin: order.profitMargin
          }
        }
      }
    });
  })
);

// @route   PUT /api/v1/transport/orders/:id/expenses
// @desc    Update truck expenses for transport order
// @access  Private (Transport Staff, Admin)
router.put('/orders/:id/expenses',
  param('id').custom(validateCuid('order ID')),
  body('truckExpenses').isDecimal().withMessage('Truck expenses must be a valid decimal'),
  body('description').optional().isLength({ max: 200 }).withMessage('Description must not exceed 200 characters'),
  authorizeModule('transport', 'write'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { truckExpenses, description } = req.body;
    const userId = req.user.id;

    // Get existing order
    const existingOrder = await prisma.transportOrder.findUnique({
      where: { id }
    });

    if (!existingOrder) {
      throw new NotFoundError('Transport order not found');
    }

    // Check permissions
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      if (existingOrder.createdBy !== userId) {
        throw new BusinessError('You can only modify your own orders', 'ACCESS_DENIED');
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // Recalculate totals with new truck expenses
      const newTotalExpenses = existingOrder.totalFuelCost + 
                              existingOrder.serviceChargeExpense + 
                              existingOrder.driverWages + 
                              parseFloat(truckExpenses);
      
      const newNetProfit = existingOrder.totalOrderAmount - newTotalExpenses;
      const newProfitMargin = existingOrder.totalOrderAmount > 0 ? 
                             (newNetProfit / existingOrder.totalOrderAmount) * 100 : 0;

      // Update transport order
      const updatedOrder = await tx.transportOrder.update({
        where: { id },
        data: {
          truckExpenses: parseFloat(truckExpenses),
          totalExpenses: newTotalExpenses,
          netProfit: newNetProfit,
          profitMargin: newProfitMargin
        }
      });

      // Create expense record for truck expenses
      if (parseFloat(truckExpenses) > 0) {
        await tx.expense.create({
          data: {
            expenseType: 'TRUCK_EXPENSE',
            category: 'MAINTENANCE',
            amount: parseFloat(truckExpenses),
            description: description || `Truck expenses for order ${existingOrder.orderNumber}`,
            referenceId: id,
            locationId: existingOrder.locationId,
            truckId: existingOrder.truckId,
            expenseDate: new Date(),
            status: 'APPROVED',
            createdBy: userId,
            approvedBy: userId,
            approvedAt: new Date()
          }
        });
      }

      // Update profit analysis
      await tx.profitAnalysis.updateMany({
        where: {
          referenceId: id,
          analysisType: 'TRANSPORT_TRIP'
        },
        data: {
          totalCosts: newTotalExpenses,
          truckExpenses: parseFloat(truckExpenses),
          grossProfit: newNetProfit,
          netProfit: newNetProfit,
          profitMargin: newProfitMargin
        }
      });

      return updatedOrder;
    });

    res.json({
      success: true,
      message: 'Transport order expenses updated successfully',
      data: { order: result }
    });
  })
);

// @route   GET /api/v1/transport/analytics/profit-analysis
// @desc    Get detailed profit analysis for transport operations
// @access  Private (Transport module access)
router.get('/analytics/profit-analysis', asyncHandler(async (req, res) => {
  const { startDate, endDate, period = 'monthly', locationId, truckId } = req.query;
  
  const where = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  if (locationId) where.locationId = locationId;
  if (truckId) where.truckId = truckId;

  // Role-based filtering
  if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
    where.createdBy = req.user.id;
  }

  const [
    totalMetrics,
    profitByLocation,
    profitByTruck,
    monthlyTrend
  ] = await Promise.all([
    // Overall profit metrics
    prisma.transportOrder.aggregate({
      where,
      _sum: {
        totalOrderAmount: true,
        totalFuelCost: true,
        serviceChargeExpense: true,
        driverWages: true,
        truckExpenses: true,
        totalExpenses: true,
        netProfit: true
      },
      _avg: {
        profitMargin: true
      },
      _count: true
    }),

    // Profit by location
    prisma.transportOrder.groupBy({
      by: ['locationId'],
      where,
      _sum: {
        totalOrderAmount: true,
        totalExpenses: true,
        netProfit: true
      },
      _avg: {
        profitMargin: true
      },
      _count: true
    }),

    // Profit by truck
    prisma.transportOrder.groupBy({
      by: ['truckId'],
      where: {
        ...where,
        truckId: { not: null }
      },
      _sum: {
        totalOrderAmount: true,
        totalExpenses: true,
        netProfit: true
      },
      _avg: {
        profitMargin: true
      },
      _count: true
    }),

    // Monthly trend (last 12 months)
    prisma.$queryRaw`
      SELECT 
        DATE_TRUNC('month', created_at) as month,
        SUM(total_order_amount) as revenue,
        SUM(total_expenses) as expenses,
        SUM(net_profit) as profit,
        AVG(profit_margin) as avg_margin,
        COUNT(*) as orders
      FROM transport_orders
      WHERE created_at >= NOW() - INTERVAL '12 months'
      ${locationId ? `AND location_id = ${locationId}` : ''}
      ${truckId ? `AND truck_id = '${truckId}'` : ''}
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY month DESC
    `
  ]);

  // Get location and truck details
  const [locations, trucks] = await Promise.all([
    prisma.location.findMany({
      where: { id: { in: profitByLocation.map(p => p.locationId) } },
      select: { id: true, name: true }
    }),
    prisma.truckCapacity.findMany({
      where: { truckId: { in: profitByTruck.map(p => p.truckId).filter(Boolean) } },
      select: { truckId: true }
    })
  ]);

  // Enhance data with names
  const profitByLocationWithNames = profitByLocation.map(p => ({
    ...p,
    location: locations.find(l => l.id === p.locationId)
  }));

  const profitByTruckWithDetails = profitByTruck.map(p => ({
    ...p,
    truck: trucks.find(t => t.truckId === p.truckId)
  }));

  res.json({
    success: true,
    data: {
      summary: {
        totalOrders: totalMetrics._count,
        totalRevenue: totalMetrics._sum.totalOrderAmount || 0,
        totalExpenses: totalMetrics._sum.totalExpenses || 0,
        totalProfit: totalMetrics._sum.netProfit || 0,
        averageProfitMargin: totalMetrics._avg.profitMargin || 0,
        costBreakdown: {
          fuel: totalMetrics._sum.totalFuelCost || 0,
          serviceCharges: totalMetrics._sum.serviceChargeExpense || 0,
          driverWages: totalMetrics._sum.driverWages || 0,
          truckExpenses: totalMetrics._sum.truckExpenses || 0
        }
      },
      profitByLocation: profitByLocationWithNames,
      profitByTruck: profitByTruckWithDetails,
      monthlyTrend
    }
  });
}));

module.exports = router;