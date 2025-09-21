const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// VALIDATION RULES
// ================================

const createTransportOrderValidation = [
  body('distributionOrderId').optional().custom(validateCuid('distribution order ID')),
  body('orderNumber').notEmpty().withMessage('Order number is required'),
  body('invoiceNumber').optional(),
  body('locationId').custom(validateCuid('location ID')),
  body('truckId').optional().custom(validateCuid('truck ID')),
  body('totalOrderAmount').isDecimal({ decimal_digits: '0,2' }).withMessage('Valid order amount required'),
  body('fuelRequired').isDecimal({ decimal_digits: '0,2' }).withMessage('Valid fuel quantity required'),
  body('fuelPricePerLiter').isDecimal({ decimal_digits: '0,2' }).withMessage('Valid fuel price required'),
  body('driverDetails').optional()
];

const updateTransportOrderValidation = [
  body('deliveryStatus').optional().isIn(['ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'DELAYED', 'CANCELLED']),
  body('driverDetails').optional(),
  body('truckExpenses').optional().isDecimal({ decimal_digits: '0,2' })
];

// ================================
// COST CALCULATION FUNCTIONS
// ================================

const calculateTransportCosts = async (
  totalOrderAmount,
  fuelRequired,
  fuelPricePerLiter,
  locationId
) => {
  // Get location for driver wages
  const location = await prisma.location.findUnique({
    where: { id: locationId }
  });

  if (!location) {
    throw new NotFoundError('Location not found');
  }

  // Calculate expenses
  const totalFuelCost = parseFloat((fuelRequired * fuelPricePerLiter).toFixed(2));
  const driverWages = parseFloat(location.driverWagesPerTrip || 0);
  
  // Service charge (typically 5% of order amount - adjust as needed)
  const serviceChargeExpense = parseFloat((totalOrderAmount * 0.05).toFixed(2));
  
  const totalExpenses = parseFloat(
    (totalFuelCost + serviceChargeExpense + driverWages).toFixed(2)
  );

  // Profit calculations
  const directCosts = totalFuelCost + driverWages;
  const grossProfit = parseFloat((totalOrderAmount - directCosts).toFixed(2));
  const netProfit = parseFloat((totalOrderAmount - totalExpenses).toFixed(2));
  const profitMargin = totalOrderAmount > 0 ? 
    parseFloat(((netProfit / totalOrderAmount) * 100).toFixed(2)) : 0;
  
  return {
    totalFuelCost,
    serviceChargeExpense,
    driverWages,
    totalExpenses,
    grossProfit,
    netProfit,
    profitMargin
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
      transportCosts: transportOrder.totalExpenses,
      grossProfit: transportOrder.grossProfit,
      netProfit: transportOrder.netProfit,
      profitMargin: transportOrder.profitMargin,
      totalOrders: 1
    }
  });
};

// ================================
// TRANSPORT ORDER ROUTES
// ================================

// @route   POST /api/v1/transport/orders
// @desc    Create new transport order with profit tracking
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

    // Check for duplicate order number
    const existingOrder = await prisma.transportOrder.findUnique({
      where: { orderNumber }
    });

    if (existingOrder) {
      throw new BusinessError('Order number already exists', 'ORDER_NUMBER_EXISTS');
    }

    // Calculate costs and profit
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
          serviceChargeExpense: costCalculation.serviceChargeExpense,
          driverWages: costCalculation.driverWages,
          totalExpenses: costCalculation.totalExpenses,
          grossProfit: costCalculation.grossProfit,
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

      // Create profit analysis
      await createProfitAnalysis(transportOrder);

      // Create expense records
      const expenseRecords = [
        {
          expenseType: 'FUEL_COST',
          category: 'FUEL',
          amount: costCalculation.totalFuelCost,
          description: `Fuel for transport order ${orderNumber}`,
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
          category: 'SERVICE_CHARGES',
          amount: costCalculation.serviceChargeExpense,
          description: `Service charges for transport order ${orderNumber}`,
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
          expenseType: 'SALARY_WAGES',
          category: 'DRIVER_WAGES',
          amount: costCalculation.driverWages,
          description: `Driver wages for transport order ${orderNumber}`,
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

      await tx.expense.createMany({
        data: expenseRecords
      });

      return transportOrder;
    });

    res.status(201).json({
      success: true,
      message: 'Transport order created successfully',
      data: { 
        order: result,
        financialSummary: {
          revenue: parseFloat(totalOrderAmount),
          totalExpenses: costCalculation.totalExpenses,
          grossProfit: costCalculation.grossProfit,
          netProfit: costCalculation.netProfit,
          profitMargin: costCalculation.profitMargin
        }
      }
    });
  })
);

// @route   GET /api/v1/transport/orders
// @desc    Get transport orders with filtering
// @access  Private (Transport module access)
router.get('/orders', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    deliveryStatus,
    locationId,
    startDate,
    endDate,
    search
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const where = {};

  // Role-based filtering
  if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
    where.createdBy = req.user.id;
  }

  if (deliveryStatus) where.deliveryStatus = deliveryStatus;
  if (locationId) where.locationId = locationId;

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

  const [orders, total] = await Promise.all([
    prisma.transportOrder.findMany({
      where,
      include: {
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
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take
    }),
    prisma.transportOrder.count({ where })
  ]);

  res.json({
    success: true,
    data: {
      orders,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// @route   GET /api/v1/transport/orders/:id
// @desc    Get single transport order
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

    // Role-based access
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
            customer: true
          }
        },
        createdByUser: {
          select: { username: true, role: true }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Transport order not found');
    }

    res.json({
      success: true,
      data: { order }
    });
  })
);

// @route   PUT /api/v1/transport/orders/:id
// @desc    Update transport order
// @access  Private (Transport Staff, Admin)
router.put('/orders/:id',
  param('id').custom(validateCuid('order ID')),
  updateTransportOrderValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;

    // Get existing order
    const existingOrder = await prisma.transportOrder.findUnique({
      where: { id }
    });

    if (!existingOrder) {
      throw new NotFoundError('Transport order not found');
    }

    // Check permissions
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      if (existingOrder.createdBy !== req.user.id) {
        throw new BusinessError('Access denied', 'INSUFFICIENT_PERMISSIONS');
      }
    }

    // If status is being updated to DELIVERED, set deliveredAt
    if (updateData.deliveryStatus === 'DELIVERED' && !existingOrder.deliveredAt) {
      updateData.deliveredAt = new Date();
    }

    const order = await prisma.transportOrder.update({
      where: { id },
      data: updateData,
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

    res.json({
      success: true,
      message: 'Transport order updated successfully',
      data: { order }
    });
  })
);

// @route   PUT /api/v1/transport/orders/:id/expenses
// @desc    Update truck expenses for an order
// @access  Private (Transport Admin)
router.put('/orders/:id/expenses',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  param('id').custom(validateCuid('order ID')),
  body('truckExpenses').isDecimal({ decimal_digits: '0,2' }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { truckExpenses } = req.body;

    const order = await prisma.transportOrder.findUnique({
      where: { id }
    });

    if (!order) {
      throw new NotFoundError('Transport order not found');
    }

    // Recalculate total expenses and profit
    const newTotalExpenses = parseFloat(
      (parseFloat(order.totalFuelCost) + 
       parseFloat(order.serviceChargeExpense) + 
       parseFloat(order.driverWages) + 
       parseFloat(truckExpenses)).toFixed(2)
    );

    const newNetProfit = parseFloat(
      (parseFloat(order.totalOrderAmount) - newTotalExpenses).toFixed(2)
    );

    const newProfitMargin = parseFloat(order.totalOrderAmount) > 0 ?
      parseFloat(((newNetProfit / parseFloat(order.totalOrderAmount)) * 100).toFixed(2)) : 0;

    const updatedOrder = await prisma.transportOrder.update({
      where: { id },
      data: {
        truckExpenses: parseFloat(truckExpenses),
        totalExpenses: newTotalExpenses,
        netProfit: newNetProfit,
        profitMargin: newProfitMargin
      },
      include: {
        location: true,
        truck: true
      }
    });

    res.json({
      success: true,
      message: 'Truck expenses updated successfully',
      data: { 
        order: updatedOrder,
        financialSummary: {
          totalExpenses: newTotalExpenses,
          netProfit: newNetProfit,
          profitMargin: newProfitMargin
        }
      }
    });
  })
);

// ================================
// ANALYTICS & REPORTS
// ================================

// @route   GET /api/v1/transport/analytics/summary
// @desc    Get transport analytics summary
// @access  Private (Transport module access)
router.get('/analytics/summary', asyncHandler(async (req, res) => {
  const { startDate, endDate, locationId } = req.query;

  const where = {};

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  if (locationId) where.locationId = locationId;

  const [
    totalOrders,
    financialSummary,
    statusBreakdown,
    locationBreakdown
  ] = await Promise.all([
    prisma.transportOrder.count({ where }),

    prisma.transportOrder.aggregate({
      where,
      _sum: {
        totalOrderAmount: true,
        totalExpenses: true,
        totalFuelCost: true,
        driverWages: true,
        serviceChargeExpense: true,
        truckExpenses: true,
        grossProfit: true,
        netProfit: true
      },
      _avg: {
        profitMargin: true
      }
    }),

    prisma.transportOrder.groupBy({
      by: ['deliveryStatus'],
      where,
      _count: { deliveryStatus: true }
    }),

    prisma.transportOrder.groupBy({
      by: ['locationId'],
      where,
      _count: true,
      _sum: {
        totalOrderAmount: true,
        netProfit: true
      },
      orderBy: {
        _sum: {
          totalOrderAmount: 'desc'
        }
      },
      take: 10
    })
  ]);

  // Get location details
  const locationIds = locationBreakdown.map(l => l.locationId);
  const locations = await prisma.location.findMany({
    where: { id: { in: locationIds } },
    select: { id: true, name: true }
  });

  const locationStats = locationBreakdown.map(lb => ({
    location: locations.find(l => l.id === lb.locationId),
    trips: lb._count,
    revenue: parseFloat((lb._sum.totalOrderAmount || 0).toFixed(2)),
    profit: parseFloat((lb._sum.netProfit || 0).toFixed(2))
  }));

  const totalRevenue = financialSummary._sum.totalOrderAmount || 0;
  const totalExpenses = financialSummary._sum.totalExpenses || 0;
  const totalProfit = financialSummary._sum.netProfit || 0;

  res.json({
    success: true,
    data: {
      totalOrders,
      financialSummary: {
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        totalExpenses: parseFloat(totalExpenses.toFixed(2)),
        grossProfit: parseFloat((financialSummary._sum.grossProfit || 0).toFixed(2)),
        netProfit: parseFloat(totalProfit.toFixed(2)),
        averageMargin: parseFloat((financialSummary._avg.profitMargin || 0).toFixed(2)),
        overallMargin: totalRevenue > 0 ? 
          parseFloat(((totalProfit / totalRevenue) * 100).toFixed(2)) : 0
      },
      expenseBreakdown: {
        fuel: parseFloat((financialSummary._sum.totalFuelCost || 0).toFixed(2)),
        driverWages: parseFloat((financialSummary._sum.driverWages || 0).toFixed(2)),
        serviceCharges: parseFloat((financialSummary._sum.serviceChargeExpense || 0).toFixed(2)),
        truckExpenses: parseFloat((financialSummary._sum.truckExpenses || 0).toFixed(2))
      },
      statusBreakdown,
      locationStats
    }
  });
}));

// @route   GET /api/v1/transport/analytics/profit-analysis
// @desc    Get detailed transport profit analysis
// @access  Private (Transport Admin)
router.get('/analytics/profit-analysis',
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
          distributionOrder: {
            include: {
              customer: true
            }
          }
        },
        orderBy: {
          createdAt: 'desc'
        },
        take: 20
      }),

      prisma.transportOrder.aggregate({
        where,
        _sum: {
          totalOrderAmount: true,
          totalExpenses: true,
          totalFuelCost: true,
          driverWages: true,
          serviceChargeExpense: true,
          grossProfit: true,
          netProfit: true
        },
        _avg: {
          profitMargin: true
        },
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

    const locationIds = locationBreakdown.map(l => l.locationId);
    const locations = await prisma.location.findMany({
      where: { id: { in: locationIds } },
      select: { id: true, name: true }
    });

    const locationsWithData = locationBreakdown.map(loc => ({
      location: locations.find(l => l.id === loc.locationId)?.name || 'Unknown',
      trips: loc._count,
      revenue: parseFloat((loc._sum.totalOrderAmount || 0).toFixed(2)),
      profit: parseFloat((loc._sum.netProfit || 0).toFixed(2))
    }));

    const totalRevenue = summary._sum.totalOrderAmount || 0;
    const totalExpenses = summary._sum.totalExpenses || 0;
    const totalProfit = summary._sum.netProfit || 0;

    res.json({
      success: true,
      data: {
        summary: {
          totalTrips: summary._count,
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalExpenses: parseFloat(totalExpenses.toFixed(2)),
          grossProfit: parseFloat((summary._sum.grossProfit || 0).toFixed(2)),
          netProfit: parseFloat(totalProfit.toFixed(2)),
          averageProfitMargin: parseFloat((summary._avg.profitMargin || 0).toFixed(2)),
          overallProfitMargin: totalRevenue > 0 ? 
            parseFloat(((totalProfit / totalRevenue) * 100).toFixed(2)) : 0
        },
        expenseBreakdown: {
          fuel: parseFloat((summary._sum.totalFuelCost || 0).toFixed(2)),
          driverWages: parseFloat((summary._sum.driverWages || 0).toFixed(2)),
          serviceCharges: parseFloat((summary._sum.serviceChargeExpense || 0).toFixed(2))
        },
        locationBreakdown: locationsWithData,
        recentOrders: orders.map(order => ({
          id: order.id,
          orderNumber: order.orderNumber,
          location: order.location.name,
          customer: order.distributionOrder?.customer?.name,
          revenue: parseFloat(order.totalOrderAmount),
          expenses: parseFloat(order.totalExpenses),
          profit: parseFloat(order.netProfit),
          margin: parseFloat(order.profitMargin),
          date: order.createdAt,
          status: order.deliveryStatus
        }))
      }
    });
  })
);

module.exports = router;