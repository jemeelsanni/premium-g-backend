const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, BusinessError } = require('../middleware/errorHandler');
const { getAuditTrail } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators'); // ✅ ADDED

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// UTILITY FUNCTIONS
// ================================

/**
 * Recursively converts BigInt values to Numbers in an object or array
 * @param {*} obj - The object/array to convert
 * @returns {*} - The converted object/array
 */
// Add this utility function at the top of routes/admin.js, after the imports

// ================================
// UTILITY FUNCTIONS
// ================================

/**
 * Recursively converts BigInt and Prisma Decimal values to Numbers in an object or array
 * @param {*} obj - The object/array to convert
 * @returns {*} - The converted object/array
 */
const convertBigIntToNumber = (obj) => {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (typeof obj === 'bigint') {
    return Number(obj);
  }
  
  // Handle Prisma Decimal objects (format: {s: 1, e: 4, d: [49940]})
  if (obj && typeof obj === 'object' && obj.s !== undefined && obj.e !== undefined && obj.d !== undefined) {
    // Convert Prisma Decimal to number
    const sign = obj.s;
    const digits = obj.d;
    const exponent = obj.e;
    
    if (digits && digits.length > 0) {
      let numStr = digits.join('');
      let result = parseFloat(numStr);
      
      // Apply exponent adjustment
      if (exponent !== digits.length) {
        result = result * Math.pow(10, exponent - digits.length);
      }
      
      return sign === -1 ? -result : result;
    }
    return 0;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(convertBigIntToNumber);
  }
  
  if (typeof obj === 'object') {
    const converted = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        converted[key] = convertBigIntToNumber(obj[key]);
      }
    }
    return converted;
  }
  
  return obj;
};


// ================================
// VALIDATION RULES - UPDATED FOR CUID
// ================================

const createProductValidation = [
  body('productNo')
    .notEmpty()
    .withMessage('Product number is required')
    .isLength({ max: 20 })
    .withMessage('Product number must not exceed 20 characters'),
  body('name')
    .notEmpty()
    .withMessage('Product name is required')
    .isLength({ max: 200 })
    .withMessage('Product name must not exceed 200 characters'),
  body('packsPerPallet')
    .isInt({ min: 1 })
    .withMessage('Packs per pallet must be a positive integer'),
  body('pricePerPack')
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Price per pack must be a valid decimal')
];

const createCustomerValidation = [
  body('name')
    .notEmpty()
    .withMessage('Customer name is required')
    .isLength({ max: 200 })
    .withMessage('Customer name must not exceed 200 characters'),
  body('email')
    .optional()
    .isEmail()
    .withMessage('Valid email is required'),
  body('phone')
    .optional()
    .isLength({ max: 20 })
    .withMessage('Phone must not exceed 20 characters')
];

const createLocationValidation = [
  body('name')
    .notEmpty()
    .withMessage('Location name is required')
    .isLength({ max: 100 })
    .withMessage('Location name must not exceed 100 characters'),
  body('fuelAdjustment')
    .optional()
    .isDecimal({ decimal_digits: '0,2' })
    .withMessage('Fuel adjustment must be a valid decimal')
];

// ================================
// SYSTEM OVERVIEW
// ================================

// @route   GET /api/v1/admin/dashboard
// @desc    Get admin dashboard overview
// @access  Private (Super Admin only)
router.get('/dashboard', asyncHandler(async (req, res) => {
  const { days = 30 } = req.query;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(days));

  const [
    systemStats,
    userStats,
    businessStats,
    recentActivity
  ] = await Promise.all([
    // System statistics
    Promise.all([
      prisma.user.count(),
      prisma.distributionOrder.count(),
      prisma.transportOrder.count(),
      prisma.warehouseSale.count(),
      prisma.auditLog.count({ where: { createdAt: { gte: startDate } } })
    ]).then(([totalUsers, totalDistributionOrders, totalTransportOrders, totalWarehouseSales, recentAuditLogs]) => ({
      totalUsers,
      totalDistributionOrders,
      totalTransportOrders,
      totalWarehouseSales,
      recentAuditLogs
    })),

    // User statistics
    prisma.user.groupBy({
      by: ['role'],
      _count: { role: true },
      where: { isActive: true }
    }),

    // Business statistics
    Promise.all([
      prisma.distributionOrder.aggregate({
        _sum: { finalAmount: true }
      }),
      prisma.transportOrder.aggregate({
        _sum: { serviceCharge: true }
      }),
      prisma.warehouseSale.aggregate({
        _sum: { totalAmount: true }
      })
    ]).then(([distributionRevenue, transportRevenue, warehouseRevenue]) => ({
      distributionRevenue: distributionRevenue._sum.finalAmount || 0,
      transportRevenue: transportRevenue._sum.serviceCharge || 0,
      warehouseRevenue: warehouseRevenue._sum.totalAmount || 0
    })),

    // Recent system activity
    prisma.auditLog.findMany({
      where: {
        createdAt: { gte: startDate }
      },
      include: {
        user: {
          select: { username: true, role: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    })
  ]);

  const totalRevenue = businessStats.distributionRevenue + 
                      businessStats.transportRevenue + 
                      businessStats.warehouseRevenue;

  res.json({
    success: true,
    data: {
      systemStats,
      userStats,
      businessStats: {
        ...businessStats,
        totalRevenue
      },
      recentActivity
    }
  });
}));

// ================================
// PRODUCT MANAGEMENT
// ================================

// @route   POST /api/v1/admin/products
// @desc    Create new product
// @access  Private (Super Admin only)
router.post('/products',
  createProductValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { productNo, name, description, packsPerPallet, pricePerPack } = req.body;

    // Check if product number already exists
    const existingProduct = await prisma.product.findUnique({
      where: { productNo }
    });

    if (existingProduct) {
      throw new BusinessError('Product number already exists', 'PRODUCT_NO_EXISTS');
    }

    const product = await prisma.product.create({
      data: {
        productNo,
        name,
        description,
        packsPerPallet: parseInt(packsPerPallet),
        pricePerPack: parseFloat(pricePerPack)
      }
    });

    // Create initial warehouse inventory record
    await prisma.warehouseInventory.create({
      data: {
        productId: product.id,
        packs: 0,
        units: 0,
        reorderLevel: 20,
        location: 'Main Warehouse'
      }
    });

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: { product }
    });
  })
);

// @route   GET /api/v1/admin/products
// @desc    Get all products
// @access  Private (Super Admin only)
router.get('/products', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    search,
    isActive
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const where = {};
  
  if (isActive !== undefined) where.isActive = isActive === 'true';
  
  if (search) {
    where.OR = [
      { productNo: { contains: search, mode: 'insensitive' } },
      { name: { contains: search, mode: 'insensitive' } }
    ];
  }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: { name: 'asc' },
      skip,
      take
    }),
    prisma.product.count({ where })
  ]);

  res.json({
    success: true,
    data: {
      products,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// @route   PUT /api/v1/admin/products/:id
// @desc    Update product
// @access  Private (Super Admin only)
router.put('/products/:id',
  param('id').custom(validateCuid('product ID')), // ✅ UPDATED
  createProductValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;

    // Convert numeric fields
    if (updateData.packsPerPallet) updateData.packsPerPallet = parseInt(updateData.packsPerPallet);
    if (updateData.pricePerPack) updateData.pricePerPack = parseFloat(updateData.pricePerPack);

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: updateData
    });

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: { product: updatedProduct }
    });
  })
);

// ================================
// CUSTOMER MANAGEMENT
// ================================

// @route   POST /api/v1/admin/customers
// @desc    Create new customer
// @access  Private (Super Admin only)
router.post('/customers',
  createCustomerValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const customer = await prisma.customer.create({
      data: req.body
    });

    res.status(201).json({
      success: true,
      message: 'Customer created successfully',
      data: { customer }
    });
  })
);

// @route   GET /api/v1/admin/customers
// @desc    Get all customers
// @access  Private (Super Admin only)
router.get('/customers', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    search,
    isActive
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const where = {};
  
  if (isActive !== undefined) where.isActive = isActive === 'true';
  
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } }
    ];
  }

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: { name: 'asc' },
      skip,
      take
    }),
    prisma.customer.count({ where })
  ]);

  res.json({
    success: true,
    data: {
      customers,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// ================================
// LOCATION MANAGEMENT
// ================================

// @route   POST /api/v1/admin/locations
// @desc    Create new location
// @access  Private (Super Admin only)
router.post('/locations',
  createLocationValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const locationData = req.body;
    if (locationData.fuelAdjustment) {
      locationData.fuelAdjustment = parseFloat(locationData.fuelAdjustment);
    }

    const location = await prisma.location.create({
      data: locationData
    });

    res.status(201).json({
      success: true,
      message: 'Location created successfully',
      data: { location }
    });
  })
);

// @route   GET /api/v1/admin/locations
// @desc    Get all locations
// @access  Private (Super Admin only)
router.get('/locations', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    search,
    isActive
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const where = {};
  
  if (isActive !== undefined) where.isActive = isActive === 'true';
  
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { address: { contains: search, mode: 'insensitive' } }
    ];
  }

  const [locations, total] = await Promise.all([
    prisma.location.findMany({
      where,
      orderBy: { name: 'asc' },
      skip,
      take
    }),
    prisma.location.count({ where })
  ]);

  res.json({
    success: true,
    data: {
      locations,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// ================================
// AUDIT TRAIL
// ================================

// @route   GET /api/v1/admin/audit-trail
// @desc    Get system audit trail
// @access  Private (Super Admin only)
router.get('/audit-trail', asyncHandler(async (req, res) => {
  const {
    userId,
    entity,
    action,
    startDate,
    endDate,
    page = 1,
    limit = 50
  } = req.query;

  const auditData = await getAuditTrail({
    userId,
    entity,
    action,
    startDate,
    endDate,
    page: parseInt(page),
    limit: parseInt(limit)
  });

  res.json({
    success: true,
    data: auditData
  });
}));

// ================================
// SYSTEM CONFIGURATION
// ================================

// @route   GET /api/v1/admin/system-config
// @desc    Get system configuration
// @access  Private (Super Admin only)
router.get('/system-config', asyncHandler(async (req, res) => {
  const configs = await prisma.systemConfig.findMany({
    orderBy: { key: 'asc' }
  });

  res.json({
    success: true,
    data: { configs }
  });
}));

// @route   PUT /api/v1/admin/system-config/:key
// @desc    Update system configuration
// @access  Private (Super Admin only)
router.put('/system-config/:key',
  param('key').notEmpty().withMessage('Configuration key is required'),
  body('value').notEmpty().withMessage('Configuration value is required'),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { key } = req.params;
    const { value, description } = req.body;

    const config = await prisma.systemConfig.upsert({
      where: { key },
      update: {
        value,
        description,
        updatedBy: req.user.id
      },
      create: {
        key,
        value,
        description,
        updatedBy: req.user.id
      }
    });

    res.json({
      success: true,
      message: 'System configuration updated successfully',
      data: { config }
    });
  })
);

// ================================
// REPORTS AND ANALYTICS
// ================================

// @route   GET /api/v1/admin/reports/consolidated
// @desc    Get consolidated business report
// @access  Private (Super Admin only)
router.get('/reports/consolidated', asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  
  const where = {};
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [
    distributionData,
    transportData,
    warehouseData,
    userActivity
  ] = await Promise.all([
    // Distribution metrics
    Promise.all([
      prisma.distributionOrder.count({ where }),
      prisma.distributionOrder.aggregate({ where, _sum: { finalAmount: true } }),
      prisma.distributionOrder.groupBy({
        by: ['status'],
        where,
        _count: { status: true }
      })
    ]).then(([count, revenue, statusBreakdown]) => ({
      totalOrders: count,
      totalRevenue: revenue._sum.finalAmount || 0,
      statusBreakdown
    })),

    // Transport metrics
    Promise.all([
      prisma.transportOrder.count({ where }),
      prisma.transportOrder.aggregate({ where, _sum: { serviceCharge: true, totalFuelCost: true } }),
      prisma.transportOrder.groupBy({
        by: ['deliveryStatus'],
        where,
        _count: { deliveryStatus: true }
      })
    ]).then(([count, financial, statusBreakdown]) => ({
      totalOrders: count,
      totalRevenue: financial._sum.serviceCharge || 0,
      totalFuelCosts: financial._sum.totalFuelCost || 0,
      statusBreakdown
    })),

    // Warehouse metrics
    Promise.all([
      prisma.warehouseSale.count({ where }),
      prisma.warehouseSale.aggregate({ where, _sum: { totalAmount: true } }),
      prisma.warehouseSale.groupBy({
        by: ['paymentMethod'],
        where,
        _count: { paymentMethod: true },
        _sum: { totalAmount: true }
      })
    ]).then(([count, revenue, paymentBreakdown]) => ({
      totalSales: count,
      totalRevenue: revenue._sum.totalAmount || 0,
      paymentBreakdown
    })),

    // User activity
    prisma.auditLog.groupBy({
      by: ['action'],
      where,
      _count: { action: true }
    })
  ]);

  const totalBusinessRevenue = distributionData.totalRevenue + 
                              transportData.totalRevenue + 
                              warehouseData.totalRevenue;

  res.json({
    success: true,
    data: {
      summary: {
        totalBusinessRevenue,
        totalOrders: distributionData.totalOrders + transportData.totalOrders,
        totalSales: warehouseData.totalSales
      },
      distribution: distributionData,
      transport: transportData,
      warehouse: warehouseData,
      userActivity
    }
  });
}));

// @route   GET /api/v1/admin/reports/performance
// @desc    Get business performance metrics
// @access  Private (Super Admin only)
router.get('/reports/performance', asyncHandler(async (req, res) => {
  const { days = 30 } = req.query;
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - parseInt(days));

  // Daily revenue trend - FIXED: Cast to NUMERIC to avoid Decimal objects
  const dailyRevenueRaw = await prisma.$queryRaw`
    SELECT 
      DATE(created_at) as date,
      'distribution' as source,
      SUM(final_amount)::numeric as revenue
    FROM distribution_orders 
    WHERE created_at >= ${startDate} AND created_at <= ${endDate}
    GROUP BY DATE(created_at)
    
    UNION ALL
    
    SELECT 
      DATE(created_at) as date,
      'transport' as source,
      SUM(service_charge)::numeric as revenue
    FROM transport_orders 
    WHERE created_at >= ${startDate} AND created_at <= ${endDate}
    GROUP BY DATE(created_at)
    
    UNION ALL
    
    SELECT 
      DATE(created_at) as date,
      'warehouse' as source,
      SUM(total_amount)::numeric as revenue
    FROM warehouse_sales 
    WHERE created_at >= ${startDate} AND created_at <= ${endDate}
    GROUP BY DATE(created_at)
    
    ORDER BY date DESC
  `;

  // Convert BigInt values to numbers using utility function
  const dailyRevenue = convertBigIntToNumber(dailyRevenueRaw);

  // Top performing products - FIXED: Cast to NUMERIC to avoid Decimal objects
  const topProductsRaw = await prisma.$queryRaw`
    SELECT 
      p.name,
      p.product_no,
      SUM(doi.amount)::numeric as total_revenue,
      COUNT(doi.id) as order_count
    FROM distribution_order_items doi
    JOIN products p ON doi.product_id = p.id
    JOIN distribution_orders dist_ord ON doi.order_id = dist_ord.id
    WHERE dist_ord.created_at >= ${startDate} AND dist_ord.created_at <= ${endDate}
    GROUP BY p.id, p.name, p.product_no
    ORDER BY total_revenue DESC
    LIMIT 10
  `;

  // Convert BigInt values to numbers using utility function
  const topProducts = convertBigIntToNumber(topProductsRaw);

  // Monthly comparison
  const currentMonthStart = new Date();
  currentMonthStart.setDate(1);
  const lastMonthStart = new Date();
  lastMonthStart.setMonth(lastMonthStart.getMonth() - 1);
  lastMonthStart.setDate(1);
  const lastMonthEnd = new Date();
  lastMonthEnd.setMonth(lastMonthEnd.getMonth(), 0);

  const [currentMonth, lastMonth] = await Promise.all([
    Promise.all([
      prisma.distributionOrder.aggregate({
        where: { createdAt: { gte: currentMonthStart } },
        _sum: { finalAmount: true },
        _count: true
      }),
      prisma.transportOrder.aggregate({
        where: { createdAt: { gte: currentMonthStart } },
        _sum: { serviceCharge: true },
        _count: true
      }),
      prisma.warehouseSale.aggregate({
        where: { createdAt: { gte: currentMonthStart } },
        _sum: { totalAmount: true },
        _count: true
      })
    ]),
    Promise.all([
      prisma.distributionOrder.aggregate({
        where: { 
          createdAt: { 
            gte: lastMonthStart, 
            lte: lastMonthEnd 
          } 
        },
        _sum: { finalAmount: true },
        _count: true
      }),
      prisma.transportOrder.aggregate({
        where: { 
          createdAt: { 
            gte: lastMonthStart, 
            lte: lastMonthEnd 
          } 
        },
        _sum: { serviceCharge: true },
        _count: true
      }),
      prisma.warehouseSale.aggregate({
        where: { 
          createdAt: { 
            gte: lastMonthStart, 
            lte: lastMonthEnd 
          } 
        },
        _sum: { totalAmount: true },
        _count: true
      })
    ])
  ]);

  const currentMonthRevenue = (currentMonth[0]._sum.finalAmount || 0) +
                             (currentMonth[1]._sum.serviceCharge || 0) +
                             (currentMonth[2]._sum.totalAmount || 0);

  const lastMonthRevenue = (lastMonth[0]._sum.finalAmount || 0) +
                          (lastMonth[1]._sum.serviceCharge || 0) +
                          (lastMonth[2]._sum.totalAmount || 0);

  const revenueGrowth = lastMonthRevenue > 0 
    ? ((currentMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100 
    : 0;

  res.json({
    success: true,
    data: {
      dailyRevenue,
      topProducts,
      monthlyComparison: {
        currentMonth: {
          revenue: currentMonthRevenue,
          orders: currentMonth[0]._count + currentMonth[1]._count + currentMonth[2]._count
        },
        lastMonth: {
          revenue: lastMonthRevenue,
          orders: lastMonth[0]._count + lastMonth[1]._count + lastMonth[2]._count
        },
        growth: {
          revenue: Math.round(revenueGrowth * 100) / 100,
          orders: lastMonth[0]._count + lastMonth[1]._count + lastMonth[2]._count > 0
            ? (((currentMonth[0]._count + currentMonth[1]._count + currentMonth[2]._count) - 
                (lastMonth[0]._count + lastMonth[1]._count + lastMonth[2]._count)) / 
                (lastMonth[0]._count + lastMonth[1]._count + lastMonth[2]._count)) * 100
            : 0
        }
      }
    }
  });
}));

module.exports = router;