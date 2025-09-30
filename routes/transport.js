const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');
const truckRoutes = require('./trucks');
const transportPricingService = require('../services/transportPricingService');

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// VALIDATION RULES
// ================================

const createTransportOrderValidation = [
  body('distributionOrderId')
    .optional()
    .custom(validateCuid('distribution order ID')),
  body('orderNumber')
    .trim()
    .notEmpty().withMessage('Order number is required')
    .isLength({ min: 3, max: 50 }).withMessage('Order number must be between 3 and 50 characters'),
  body('invoiceNumber')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 50 }).withMessage('Invoice number must not exceed 50 characters'),
  body('locationId')
    .custom(validateCuid('location ID')),
  body('truckId')
    .optional({ nullable: true, checkFalsy: true }), // Remove CUID validation - just make it optional
  body('totalOrderAmount')
    .isFloat({ min: 0 }).withMessage('Total order amount must be 0 or greater'),
  body('fuelRequired')
    .isFloat({ min: 0 }).withMessage('Fuel required must be 0 or greater'),
  body('fuelPricePerLiter')
    .isFloat({ min: 0 }).withMessage('Fuel price per liter must be 0 or greater'),
  body('driverDetails')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ max: 500 }).withMessage('Driver details must not exceed 500 characters')
];

const updateTransportOrderValidation = [
  body('deliveryStatus').optional().isIn(['ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'DELAYED', 'CANCELLED']),
  body('driverDetails').optional(),
  body('truckExpenses').optional().isDecimal({ decimal_digits: '0,2' })
];

// const calculateTransportProfitability = async (
//   totalOrderAmount,
//   fuelRequired,
//   fuelPricePerLiter,
//   locationId,
//   serviceChargePercentage = 10.00
// ) => {
//   // Get location for driver wages
//   const location = await prisma.location.findUnique({
//     where: { id: locationId }
//   });

//   if (!location) {
//     throw new NotFoundError('Location not found');
//   }

//   // Calculate expenses
//   const totalFuelCost = parseFloat((fuelRequired * fuelPricePerLiter).toFixed(2));
//   const serviceChargeExpense = parseFloat(((totalOrderAmount * serviceChargePercentage) / 100).toFixed(2));
//   const driverWages = parseFloat(location.driverWagesPerTrip || 0);
  
//   const totalTripExpenses = parseFloat(
//     (totalFuelCost + serviceChargeExpense + driverWages).toFixed(2)
//   );

//   // Profit calculations
//   const grossProfit = parseFloat((totalOrderAmount - totalTripExpenses).toFixed(2));
//   const netProfit = grossProfit; // For individual trips
//   const profitMargin = totalOrderAmount > 0 ? 
//     parseFloat(((netProfit / totalOrderAmount) * 100).toFixed(2)) : 0;
  
//   return {
//     totalFuelCost,
//     serviceChargeExpense,
//     driverWages,
//     totalTripExpenses,
//     grossProfit,
//     netProfit,
//     profitMargin
//   };
// };

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

// GET price calculation preview
router.post('/orders/calculate-price',
  authorizeModule('transport', 'read'),
  [
    body('locationId').custom(validateCuid('location ID')),
    body('truckId').custom(validateCuid('truck ID')),
    body('fuelRequired').isFloat({ min: 0 }),
    body('fuelPricePerLiter').isFloat({ min: 0 }),
    body('truckExpenses').optional().isFloat({ min: 0 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { locationId, truckId, fuelRequired, fuelPricePerLiter, truckExpenses = 0 } = req.body;

    const calculation = await transportPricingService.calculateTripCosts({
      locationId,
      truckId,
      fuelRequired,
      fuelPricePerLiter,
      additionalExpenses: truckExpenses
    });

    // Get location and truck details for display
    const [location, truck] = await Promise.all([
      prisma.location.findUnique({ where: { id: locationId } }),
      prisma.truckCapacity.findUnique({ where: { truckId } })
    ]);

    res.json({
      success: true,
      data: {
        location: {
          name: location.name,
          distance: calculation.distance || 'N/A'
        },
        truck: {
          registration: truck.registrationNumber,
          capacity: truck.capacity,
          capacityType: truck.capacityType
        },
        pricing: {
          baseHaulageRate: calculation.baseHaulageRate,
          totalTripCost: calculation.totalOrderAmount,
          breakdown: {
            fuel: {
              liters: calculation.fuelRequired,
              pricePerLiter: calculation.fuelPricePerLiter,
              total: calculation.totalFuelCost
            },
            wages: {
              tripAllowance: calculation.tripAllowance,
              driverWages: calculation.driverWages,
              motorBoyWages: calculation.motorBoyWages,
              total: calculation.totalDriverWages
            },
            serviceCharge: {
              percentage: calculation.serviceChargePercent,
              amount: calculation.serviceChargeExpense
            },
            expenses: calculation.truckExpenses
          },
          totals: {
            totalExpenses: calculation.totalTripExpenses,
            grossProfit: calculation.grossProfit,
            netProfit: calculation.netProfit,
            profitMargin: `${calculation.profitMargin}%`,
            revenue: calculation.revenue
          }
        }
      }
    });
  })
);

// ================================
// TRANSPORT ORDER ROUTES
// ================================

// @route   POST /api/v1/transport/orders
// @desc    Create new transport order with profit tracking
// @access  Private (Transport Staff, Admin)
router.post('/orders',
  authorizeModule('transport', 'write'),
  [
    body('orderNumber').trim().notEmpty().withMessage('Order number is required'),
    body('clientName').trim().notEmpty().withMessage('Client name is required'),
    body('clientPhone').optional().trim(),
    body('pickupLocation').trim().notEmpty().withMessage('Pickup location is required'),
    body('deliveryAddress').trim().notEmpty().withMessage('Delivery address is required'),
    body('locationId').custom(validateCuid('location ID')),
    body('truckId').custom(validateCuid('truck ID')).withMessage('Truck ID is required'),
    body('fuelRequired').isFloat({ min: 0 }).withMessage('Fuel required must be 0 or greater'),
    body('fuelPricePerLiter').isFloat({ min: 0 }).withMessage('Fuel price per liter must be 0 or greater'),
    body('truckExpenses').optional().isFloat({ min: 0 }).withMessage('Truck expenses must be 0 or greater'),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      orderNumber,
      invoiceNumber,
      clientName,
      clientPhone,
      pickupLocation,
      deliveryAddress,
      locationId,
      truckId,
      fuelRequired,
      fuelPricePerLiter,
      truckExpenses = 0,
      driverDetails
    } = req.body;

    const userId = req.user.id;

    // AUTO-CALCULATE all costs using the new pricing service
    const calculatedCosts = await transportPricingService.calculateTripCosts({
      locationId,
      truckId,
      fuelRequired,
      fuelPricePerLiter,
      additionalExpenses: truckExpenses
    });

    // Create standalone transport order
    const transportOrder = await prisma.$transaction(async (tx) => {
      const order = await tx.transportOrder.create({
        data: {
          orderNumber,
          invoiceNumber,
          clientName,
          clientPhone,
          pickupLocation,
          deliveryAddress,
          locationId,
          truckId,
          driverDetails,
          
          // Calculated pricing from haulage rates
          baseHaulageRate: calculatedCosts.baseHaulageRate,
          totalOrderAmount: calculatedCosts.totalOrderAmount, // This is the trip cost
          
          // Fuel costs
          fuelRequired: calculatedCosts.fuelRequired,
          fuelPricePerLiter: calculatedCosts.fuelPricePerLiter,
          totalFuelCost: calculatedCosts.totalFuelCost,
          
          // Wages breakdown (from salary rates)
          tripAllowance: calculatedCosts.tripAllowance,
          driverWages: calculatedCosts.driverWages,
          motorBoyWages: calculatedCosts.motorBoyWages,
          
          // Service charge (10% of haulage rate)
          serviceChargePercent: calculatedCosts.serviceChargePercent,
          serviceChargeExpense: calculatedCosts.serviceChargeExpense,
          
          // Expenses
          truckExpenses: calculatedCosts.truckExpenses,
          totalTripExpenses: calculatedCosts.totalTripExpenses,
          
          // Profit (matching Excel formula)
          grossProfit: calculatedCosts.grossProfit,
          netProfit: calculatedCosts.netProfit,
          profitMargin: calculatedCosts.profitMargin,
          
          createdBy: userId,
          deliveryStatus: 'PENDING'
        },
        include: {
          location: true,
          truck: true,
          createdByUser: {
            select: { id: true, username: true }
          }
        }
      });

      // Create transport analytics entry
      await tx.transportAnalytics.create({
        data: {
          analysisType: 'TRANSPORT_TRIP',
          totalRevenue: calculatedCosts.totalOrderAmount,
          fuelCosts: calculatedCosts.totalFuelCost,
          driverWages: calculatedCosts.driverWages + calculatedCosts.tripAllowance + calculatedCosts.motorBoyWages,
          serviceCharges: calculatedCosts.serviceChargeExpense,
          totalExpenses: calculatedCosts.totalTripExpenses,
          grossProfit: calculatedCosts.grossProfit,
          netProfit: calculatedCosts.netProfit,
          profitMargin: calculatedCosts.profitMargin,
          totalTrips: 1
        }
      });

      // Log audit trail
      await tx.auditLog.create({
        data: {
          userId,
          action: 'CREATE',
          entity: 'TransportOrder',
          entityId: order.id,
          newValues: {
            orderNumber: order.orderNumber,
            clientName: order.clientName,
            location: order.location.name,
            totalAmount: order.totalOrderAmount,
            netProfit: order.netProfit
          }
        }
      });

      return order;
    });

    res.status(201).json({
      success: true,
      message: 'Transport order created successfully with auto-calculated pricing',
      data: { 
        transportOrder,
        calculation: {
          baseHaulageRate: calculatedCosts.baseHaulageRate,
          breakdown: {
            fuel: calculatedCosts.totalFuelCost,
            wages: calculatedCosts.driverWages + calculatedCosts.tripAllowance + calculatedCosts.motorBoyWages,
            serviceCharge: calculatedCosts.serviceChargeExpense,
            expenses: calculatedCosts.truckExpenses
          },
          revenue: calculatedCosts.revenue,
          profitMargin: `${calculatedCosts.profitMargin}%`
        }
      }
    });
  })
);

// @route   GET /api/v1/transport/orders
// @desc    Get transport orders with filtering
// @access  Private (Transport module access)
router.get('/orders', 
  authorizeModule('transport'),
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      status,
      clientName,
      locationId,
      truckId,
      startDate,
      endDate
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};
    
    if (status) where.deliveryStatus = status;
    if (clientName) where.clientName = { contains: clientName, mode: 'insensitive' };
    if (locationId) where.locationId = locationId;
    if (truckId) where.truckId = truckId;
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    // Role-based filtering for non-admin users
    if (!['SUPER_ADMIN', 'TRANSPORT_ADMIN'].includes(req.user.role)) {
      where.createdBy = req.user.id;
    }

    const [orders, total] = await Promise.all([
      prisma.transportOrder.findMany({
        where,
        include: {
          location: true,
          truck: true,
          createdByUser: {
            select: { id: true, username: true }
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
  })
);


router.post('/expenses',
  authorizeModule('transport', 'write'),
  [
    body('truckId').optional().trim(),
    body('expenseType').trim().notEmpty().withMessage('Expense type is required'),
    body('amount').isFloat({ min: 0 }).withMessage('Amount must be greater than 0'),
    body('description').optional().trim(),
    body('expenseDate').isISO8601().withMessage('Valid expense date is required')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      truckId,
      expenseType,
      amount,
      description,
      expenseDate,
      receiptUrl
    } = req.body;

    const expense = await prisma.transportExpense.create({
      data: {
        truckId,
        expenseType,
        amount,
        description,
        expenseDate: new Date(expenseDate),
        receiptUrl,
        createdBy: req.user.id
      },
      include: {
        truck: true,
        createdByUser: {
          select: { id: true, username: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Transport expense created successfully',
      data: { expense }
    });
  })
);

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
router.get('/analytics/summary',
  authorizeModule('transport'),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    // Get transport orders
    const orders = await prisma.transportOrder.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
        deliveryStatus: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
      }
    });

    // Get transport expenses (non-trip)
    const expenses = await prisma.transportExpense.findMany({
      where: {
        expenseDate: Object.keys(dateFilter).length > 0 ? dateFilter : undefined,
        status: 'APPROVED'
      }
    });

    // Calculate metrics
    let totalRevenue = 0;
    let totalTripExpenses = 0;
    let totalFuelCosts = 0;
    let totalDriverWages = 0;
    let totalServiceCharges = 0;

    orders.forEach(order => {
      totalRevenue += parseFloat(order.totalOrderAmount);
      totalTripExpenses += parseFloat(order.totalTripExpenses);
      totalFuelCosts += parseFloat(order.totalFuelCost);
      totalDriverWages += parseFloat(order.driverWages);
      totalServiceCharges += parseFloat(order.serviceChargeExpense);
    });

    const totalNonTripExpenses = expenses.reduce(
      (sum, expense) => sum + parseFloat(expense.amount), 0
    );

    const totalExpenses = totalTripExpenses + totalNonTripExpenses;
    const netProfit = totalRevenue - totalExpenses;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

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
          totalExpenses: parseFloat(totalExpenses.toFixed(2)),
          netProfit: parseFloat(netProfit.toFixed(2)),
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          totalTrips: orders.length
        },
        period: { startDate, endDate }
      }
    });
  })
);

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



router.use('/', truckRoutes);

module.exports = router;