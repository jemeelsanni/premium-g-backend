const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');

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
    .isUUID()
    .withMessage('Invalid location ID format'),
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

const updateTransportOrderValidation = [
  body('deliveryStatus')
    .optional()
    .isIn(['ASSIGNED', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'DELAYED', 'CANCELLED'])
    .withMessage('Invalid delivery status'),
  body('truckExpenses')
    .optional()
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Truck expenses must be a valid decimal'),
  body('driverSalary')
    .optional()
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Driver salary must be a valid decimal'),
  body('driverDetails')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Driver details must not exceed 200 characters')
];

// ================================
// BUSINESS LOGIC FUNCTIONS
// ================================

const calculateTransportCosts = (totalOrderAmount, fuelRequired, fuelPricePerLiter) => {
  const totalFuelCost = parseFloat((fuelRequired * fuelPricePerLiter).toFixed(2));
  const serviceCharge = parseFloat((totalOrderAmount * 0.10).toFixed(2)); // 10% service charge
  
  return {
    totalFuelCost,
    serviceCharge
  };
};

// ================================
// ROUTES - TRANSPORT ORDERS
// ================================

// @route   POST /api/v1/transport/orders
// @desc    Create new transport order
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

    // Calculate costs
    const { totalFuelCost, serviceCharge } = calculateTransportCosts(
      parseFloat(totalOrderAmount),
      parseFloat(fuelRequired),
      parseFloat(fuelPricePerLiter)
    );

    // Create transport order
    const transportOrder = await prisma.transportOrder.create({
      data: {
        distributionOrderId: distributionOrderId || null,
        orderNumber,
        invoiceNumber,
        locationId,
        truckId,
        totalOrderAmount: parseFloat(totalOrderAmount),
        fuelRequired: parseFloat(fuelRequired),
        fuelPricePerLiter: parseFloat(fuelPricePerLiter),
        totalFuelCost,
        serviceCharge,
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

    res.status(201).json({
      success: true,
      message: 'Transport order created successfully',
      data: { transportOrder }
    });
  })
);

// @route   GET /api/v1/transport/orders
// @desc    Get transport orders with filtering and pagination
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
    search
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
  param('id').isUUID().withMessage('Invalid order ID'),
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
// @access  Private (Own entries or Admin)
router.put('/orders/:id',
  param('id').isUUID().withMessage('Invalid order ID'),
  updateTransportOrderValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;
    const userId = req.user.id;

    // Get existing order
    const existingOrder = await prisma.transportOrder.findUnique({
      where: { id }
    });

    if (!existingOrder) {
      throw new NotFoundError('Transport order not found');
    }

    // Check permissions - users can only modify their own entries
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      if (existingOrder.createdBy !== userId) {
        throw new BusinessError('You can only modify your own orders', 'ACCESS_DENIED');
      }
    } else if (req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      // Admins can only view, not modify
      throw new BusinessError('Admins have view-only access to user entries', 'ADMIN_VIEW_ONLY');
    }

    // Handle delivery status update
    if (updateData.deliveryStatus === 'DELIVERED' && !existingOrder.deliveredAt) {
      updateData.deliveredAt = new Date();
    }

    // Update order
    const updatedOrder = await prisma.transportOrder.update({
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

    // Log the change
    await logDataChange(
      userId,
      'transport_order',
      id,
      'UPDATE',
      existingOrder,
      updatedOrder,
      getClientIP(req)
    );

    res.json({
      success: true,
      message: 'Transport order updated successfully',
      data: { order: updatedOrder }
    });
  })
);

// ================================
// ROUTES - ANALYTICS & REPORTS
// ================================

// @route   GET /api/v1/transport/analytics/summary
// @desc    Get transport analytics summary
// @access  Private (Transport module access)
router.get('/analytics/summary', asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  
  const where = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  // Role-based filtering
  if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
    where.createdBy = req.user.id;
  }

  const [
    totalOrders,
    totalRevenue,
    totalFuelCosts,
    statusCounts,
    deliveryStatusCounts,
    avgDeliveryTime
  ] = await Promise.all([
    prisma.transportOrder.count({ where }),
    
    prisma.transportOrder.aggregate({
      where,
      _sum: { serviceCharge: true }
    }),

    prisma.transportOrder.aggregate({
      where,
      _sum: { totalFuelCost: true }
    }),

    prisma.transportOrder.groupBy({
      by: ['deliveryStatus'],
      where,
      _count: { deliveryStatus: true }
    }),

    prisma.transportOrder.count({
      where: {
        ...where,
        deliveryStatus: 'DELIVERED'
      }
    }),

    prisma.transportOrder.findMany({
      where: {
        ...where,
        deliveryStatus: 'DELIVERED',
        deliveredAt: { not: null }
      },
      select: {
        createdAt: true,
        deliveredAt: true
      }
    })
  ]);

  // Calculate average delivery time
  let averageDeliveryHours = 0;
  if (avgDeliveryTime.length > 0) {
    const totalHours = avgDeliveryTime.reduce((acc, order) => {
      const hours = (order.deliveredAt - order.createdAt) / (1000 * 60 * 60);
      return acc + hours;
    }, 0);
    averageDeliveryHours = totalHours / avgDeliveryTime.length;
  }

  res.json({
    success: true,
    data: {
      totalOrders,
      totalRevenue: totalRevenue._sum.serviceCharge || 0,
      totalFuelCosts: totalFuelCosts._sum.totalFuelCost || 0,
      deliveryStatusDistribution: statusCounts,
      completedDeliveries: deliveryStatusCounts,
      averageDeliveryTime: Math.round(averageDeliveryHours * 100) / 100 // Round to 2 decimal places
    }
  });
}));

// @route   GET /api/v1/transport/analytics/fuel-costs
// @desc    Get fuel cost analytics
// @access  Private (Transport module access)
router.get('/analytics/fuel-costs', asyncHandler(async (req, res) => {
  const { startDate, endDate, groupBy = 'day' } = req.query;
  
  const where = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  // Role-based filtering
  if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
    where.createdBy = req.user.id;
  }

  const fuelAnalytics = await prisma.transportOrder.findMany({
    where,
    select: {
      createdAt: true,
      totalFuelCost: true,
      fuelRequired: true,
      fuelPricePerLiter: true,
      location: {
        select: { name: true }
      }
    },
    orderBy: { createdAt: 'asc' }
  });

  // Group by location for fuel efficiency analysis
  const locationAnalytics = await prisma.transportOrder.groupBy({
    by: ['locationId'],
    where,
    _sum: {
      totalFuelCost: true,
      fuelRequired: true
    },
    _avg: {
      fuelRequired: true
    },
    _count: {
      locationId: true
    }
  });

  // Get location details
  const locationIds = locationAnalytics.map(l => l.locationId);
  const locations = await prisma.location.findMany({
    where: { id: { in: locationIds } },
    select: { id: true, name: true }
  });

  const locationAnalyticsWithNames = locationAnalytics.map(analytics => ({
    ...analytics,
    location: locations.find(l => l.id === analytics.locationId)
  }));

  res.json({
    success: true,
    data: {
      fuelCostTrend: fuelAnalytics,
      locationAnalytics: locationAnalyticsWithNames
    }
  });
}));

module.exports = router;