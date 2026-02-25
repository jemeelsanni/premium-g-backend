// routes/transport.js - COMPLETE FIXED VERSION

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { Parser } = require('json2csv');
const PDFDocument = require('pdfkit-table', { PDFDocument: require('pdfkit') });


const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = require('../lib/prisma');

// ================================
// MIDDLEWARE
// ================================
router.use(authorizeModule('transport'));

// ================================
// VALIDATION RULES
// ================================

const createTransportOrderValidation = [
  body('orderNumber').notEmpty().withMessage('Order number is required'),
  body('clientName').notEmpty().withMessage('Client name is required'),
  body('clientPhone').optional().trim(),
  body('pickupLocation').optional().trim(),
  body('locationId').notEmpty().custom(validateCuid('location ID')),
  body('totalOrderAmount').isFloat({ min: 0 }).withMessage('Order amount must be positive'),
  body('fuelCostPerLitre').isFloat({ min: 0 }).withMessage('Fuel cost per litre must be positive'),
  body('tripAllowance').optional().isFloat({ min: 0 }).withMessage('Trip allowance must be positive'),
  body('truckId')
    .optional()
    .custom((value) => {
      if (!value || value === '') return true;
      if (typeof value === 'string' && value.length >= 3 && value.length <= 50) return true;
      throw new Error('Invalid truck ID format');
    }),
  body('driverDetails').optional().trim(),
  body('invoiceNumber').optional().trim(),
];

const updateTransportOrderValidation = [
  body('clientName').optional().notEmpty(),
  body('pickupLocation').optional().trim(),
  body('totalOrderAmount').optional().isFloat({ min: 0 }),
  body('fuelCostPerLitre').optional().isFloat({ min: 0 }),
  body('truckId').optional().custom(validateCuid('truck ID')),
  body('driverDetails').optional().trim(),
  body('truckExpensesDescription').optional().trim()
];

const createExpenseValidation = [
  body('truckId')
    .optional({ nullable: true, checkFalsy: true })  // ✅ Allow empty strings
    .custom((value) => {
      if (!value || value === '') return true;  // Allow empty
      // If provided, validate it's a reasonable truck ID format
      if (typeof value === 'string' && value.length >= 3 && value.length <= 50) {
        return true;
      }
      throw new Error('Invalid truck ID format');
    }),
  body('locationId')
    .optional({ nullable: true, checkFalsy: true })  // ✅ Allow empty strings
    .custom((value) => {
      if (!value || value === '') return true;  // Allow empty
      return validateCuid('location ID')(value);  // Validate if provided
    }),
  body('expenseType').isIn(['TRIP', 'NON_TRIP']).withMessage('Invalid expense type'),
  body('category').notEmpty().withMessage('Category is required'),
  body('amount').isFloat({ min: 0 }).withMessage('Amount must be positive'),
  body('description').notEmpty().withMessage('Description is required'),
  body('expenseDate').isISO8601().withMessage('Invalid date format'),
  body('receiptNumber').optional({ nullable: true, checkFalsy: true }).trim()
];

// ================================
// HELPER FUNCTIONS
// ================================

async function calculateOrderCosts(
  locationId,
  fuelRequired,
  fuelPricePerLiter,
  totalOrderAmount,
  driverWages,
  tripAllowance
) {
  // Get haulage rate for location
  const haulageRate = await prisma.haulageRate.findFirst({
    where: {
      locationId,
      isActive: true
    },
    orderBy: { effectiveDate: 'desc' }
  });

  const baseHaulageRate = haulageRate ? parseFloat(haulageRate.rate) : 50000;

  // Calculate costs
  const totalFuelCost = fuelRequired * fuelPricePerLiter;
  const serviceChargePercent = 10;
  const serviceChargeExpense = (serviceChargePercent / 100) * baseHaulageRate;
  const truckExpenses = 0; // Initial, can be updated later

  const totalTripExpenses = totalFuelCost + driverWages + tripAllowance + serviceChargeExpense + truckExpenses;

  const revenue = totalOrderAmount;
  const grossProfit = revenue - totalFuelCost - driverWages - tripAllowance;
  const netProfit = revenue - totalTripExpenses;
  const profitMargin = revenue > 0 ? parseFloat(((netProfit / revenue) * 100).toFixed(2)) : 0;

  return {
    baseHaulageRate,
    fuelRequired,
    fuelPricePerLiter,
    totalFuelCost,
    driverWages,
    tripAllowance,
    serviceChargePercent,
    serviceChargeExpense,
    truckExpenses,
    totalTripExpenses,
    grossProfit,
    netProfit,
    profitMargin,
    revenue,
    totalOrderAmount
  };
}

// ================================
// TRANSPORT ORDERS
// ================================

// @route   POST /api/v1/transport/orders
// @desc    Create transport order (with automatic cash flow for revenue + trip expenses)
// @access  Private (Transport module access)
router.post('/orders',
  authorizeModule('transport', 'write'),
  createTransportOrderValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      clientName,
      clientPhone,
      pickupLocation,
      locationId,
      totalOrderAmount,
      fuelCostPerLitre,
      tripAllowance,
      truckId,
      driverDetails,
      invoiceNumber,
      paymentMethod
    } = req.body;

    const userId = req.user.id;

    // Fetch location to get pre-configured costs (fuelRequired and driverWages)
    const location = await prisma.location.findUnique({
      where: { id: locationId },
      select: { fuelRequired: true, driverWages: true, name: true }
    });
    if (!location) throw new NotFoundError('Location not found');

    const fuelRequired = parseFloat(location.fuelRequired);
    const fuelPricePerLiter = parseFloat(fuelCostPerLitre);
    const driverWages = parseFloat(location.driverWages);
    const resolvedTripAllowance = tripAllowance ? parseFloat(tripAllowance) : 0;

    // Generate order number
    const orderCount = await prisma.transportOrder.count();
    const orderNumber = `TO-${new Date().getFullYear()}-${String(orderCount + 1).padStart(4, '0')}`;

    // Calculate costs from location rates
    const totalFuelCost = fuelRequired * fuelPricePerLiter;
    const serviceChargePercent = 10.0;
    const serviceChargeExpense = (parseFloat(totalOrderAmount) * serviceChargePercent) / 100;

    // Total wages (driver + optional trip allowance)
    const totalWages = driverWages + resolvedTripAllowance;

    const totalTripExpenses = totalFuelCost + totalWages + serviceChargeExpense;
    const grossProfit = parseFloat(totalOrderAmount) - totalTripExpenses;
    const netProfit = grossProfit;
    const profitMargin = totalOrderAmount > 0 ? (grossProfit / totalOrderAmount) * 100 : 0;

    // ✨ USE TRANSACTION to create order + ALL cash flow entries atomically
    const result = await prisma.$transaction(async (tx) => {
      // 1. CREATE TRANSPORT ORDER
      const order = await tx.transportOrder.create({
        data: {
          orderNumber,
          name: clientName,
          phone: clientPhone,
          pickupLocation: pickupLocation || null,
          deliveryAddress: null,
          locationId,
          totalOrderAmount: parseFloat(totalOrderAmount),
          fuelRequired,
          fuelPricePerLiter,
          totalFuelCost,
          driverWages,
          tripAllowance: resolvedTripAllowance,
          serviceChargeExpense,
          totalTripExpenses,
          grossProfit,
          netProfit,
          profitMargin,
          truckId: truckId || null,
          driverDetails,
          invoiceNumber,
          deliveryStatus: 'PENDING',
          createdBy: userId,
          serviceChargePercent: 10.0,
          truckExpenses: 0.0,
          baseHaulageRate: parseFloat(totalOrderAmount),
          totalExpenses: totalTripExpenses,
          deliveryDate: null,
          truckExpensesDescription: null,
          distributionOrderId: null
        },
        include: {
          location: true,
          truck: true,
          createdByUser: {
            select: { username: true }
          }
        }
      });

      // 2. ✨ CREATE REVENUE CASH FLOW ENTRY (CASH_IN) ✨
      const revenueCashFlow = await tx.cashFlow.create({
        data: {
          transactionType: 'CASH_IN',
          amount: parseFloat(totalOrderAmount),
          paymentMethod: paymentMethod || 'BANK_TRANSFER',
          description: `Transport Revenue: ${clientName} - ${pickupLocation || location.name}`,
          referenceNumber: orderNumber,
          cashier: userId,
          module: 'TRANSPORT'
        }
      });

      // 3. ✨ CREATE FUEL EXPENSE CASH FLOW ENTRY (CASH_OUT) ✨
      const fuelCashFlow = await tx.cashFlow.create({
        data: {
          transactionType: 'CASH_OUT',
          amount: totalFuelCost,
          paymentMethod: 'CASH', // Fuel typically paid in cash
          description: `Fuel Cost: ${orderNumber} - ${fuelRequired}L @ ₦${fuelPricePerLiter.toFixed(2)}/L`,
          referenceNumber: `${orderNumber}-FUEL`,
          cashier: userId,
          module: 'TRANSPORT'
        }
      });

      // 4. ✨ CREATE WAGES EXPENSE CASH FLOW ENTRY (CASH_OUT) ✨
      const wagesCashFlow = await tx.cashFlow.create({
        data: {
          transactionType: 'CASH_OUT',
          amount: totalWages,
          paymentMethod: 'CASH', // Wages typically paid in cash
          description: `Wages & Allowances: ${orderNumber} - Driver: ₦${driverWages}, Trip: ₦${resolvedTripAllowance}`,
          referenceNumber: `${orderNumber}-WAGES`,
          cashier: userId,
          module: 'TRANSPORT'
        }
      });

      // 5. ✨ CREATE SERVICE CHARGE EXPENSE CASH FLOW ENTRY (CASH_OUT) ✨
      const serviceChargeCashFlow = await tx.cashFlow.create({
        data: {
          transactionType: 'CASH_OUT',
          amount: serviceChargeExpense,
          paymentMethod: 'BANK_TRANSFER', // Service charges typically via transfer
          description: `Service Charge (10%): ${orderNumber} - ₦${totalOrderAmount.toLocaleString()} × 10%`,
          referenceNumber: `${orderNumber}-SERVICE`,
          cashier: userId,
          module: 'TRANSPORT'
        }
      });

      console.log('✅ Transport order & cash flow entries created:', {
        orderNumber,
        revenue: totalOrderAmount,
        expenses: {
          fuel: totalFuelCost,
          wages: totalWages,
          serviceCharge: serviceChargeExpense,
          total: totalTripExpenses
        },
        profit: netProfit
      });

      return { 
        order, 
        cashFlowEntries: {
          revenue: revenueCashFlow,
          fuel: fuelCashFlow,
          wages: wagesCashFlow,
          serviceCharge: serviceChargeCashFlow
        }
      };
    });

    // Log the creation
    await logDataChange(
      userId,
      'transport_order',
      result.order.id,
      'CREATE',
      null,
      result.order,
      getClientIP(req)
    );

    res.status(201).json({
      success: true,
      message: 'Transport order created successfully. All cash flow entries recorded automatically.',
      data: { 
        order: result.order,
        cashFlowRecorded: true,
        cashFlowSummary: {
          revenueRecorded: parseFloat(totalOrderAmount),
          expensesRecorded: {
            fuel: totalFuelCost,
            wages: totalWages,
            serviceCharge: serviceChargeExpense,
            total: totalTripExpenses
          },
          netCashFlow: parseFloat(totalOrderAmount) - totalTripExpenses
        }
      }
    });
  })
);

// @route   GET /api/v1/transport/orders
// @desc    Get transport orders with filtering and pagination
// @access  Private (Transport module access)
router.get('/orders',
  authorizeModule('transport'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
    query('status').optional(),
    query('clientName').optional().trim(),
    query('locationId').optional(),
    query('truckId').optional(),
    query('startDate').optional().isISO8601().withMessage('Invalid start date'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date'),
    query('search').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const {
      page = 1,
      limit = 20,
      status,
      clientName,
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

    if (status) where.deliveryStatus = status;
    if (locationId) where.locationId = locationId;
    if (truckId) where.truckId = truckId;

    // Date range filtering
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    // Search functionality
    if (search) {
      where.OR = [
        { clientName: { contains: search, mode: 'insensitive' } },
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { clientPhone: { contains: search, mode: 'insensitive' } },
        { pickupLocation: { contains: search, mode: 'insensitive' } },
        { deliveryAddress: { contains: search, mode: 'insensitive' } }
      ];
    }

    if (clientName) {
      where.clientName = { contains: clientName, mode: 'insensitive' };
    }

    // Fetch orders with pagination
    const [orders, total] = await Promise.all([
      prisma.transportOrder.findMany({
        where,
        include: {
          location: {
            select: { id: true, name: true, address: true }
          },
          truck: {
            select: { id: true, truckId: true, registrationNumber: true }
          },
          createdByUser: {
            select: { id: true, username: true, role: true }
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

// @route   GET /api/v1/transport/cash-flow
// @desc    Get transport cash flow entries with filtering
// @access  Private (Transport module access)
router.get('/cash-flow',
  authorizeModule('transport'),
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      transactionType,
      paymentMethod,
      startDate,
      endDate,
      isReconciled
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {
      module: 'TRANSPORT'  // ✨ CRITICAL: This line filters to transport only
    };

    if (transactionType) where.transactionType = transactionType;
    if (paymentMethod) where.paymentMethod = paymentMethod;
    
    if (isReconciled !== undefined) {
      where.isReconciled = isReconciled === 'true';
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [entries, total] = await Promise.all([
      prisma.cashFlow.findMany({
        where,
        include: {
          cashierUser: {
            select: { username: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      prisma.cashFlow.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        cashFlowEntries: entries,
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
        // ✅ REMOVED distributionOrder reference
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
    const userId = req.user.id;

    const existingOrder = await prisma.transportOrder.findUnique({
      where: { id }
    });

    if (!existingOrder) {
      throw new NotFoundError('Transport order not found');
    }

    // Check permissions
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      if (existingOrder.createdBy !== userId) {
        throw new BusinessError('You can only update your own orders', 'PERMISSION_DENIED');
      }
    }

    // Recalculate if financial fields changed
    let calculatedCosts = null;
    if (updateData.fuelRequired || updateData.fuelPricePerLiter || updateData.totalOrderAmount) {
      calculatedCosts = await calculateOrderCosts(
        updateData.locationId || existingOrder.locationId,
        updateData.fuelRequired || parseFloat(existingOrder.fuelRequired),
        updateData.fuelPricePerLiter || parseFloat(existingOrder.fuelPricePerLiter),
        updateData.totalOrderAmount || parseFloat(existingOrder.totalOrderAmount)
      );

      Object.assign(updateData, {
        totalFuelCost: calculatedCosts.totalFuelCost,
        driverWages: calculatedCosts.driverWages,
        tripAllowance: calculatedCosts.tripAllowance,
        serviceChargeExpense: calculatedCosts.serviceChargeExpense,
        totalTripExpenses: calculatedCosts.totalTripExpenses,
        grossProfit: calculatedCosts.grossProfit,
        netProfit: calculatedCosts.netProfit,
        profitMargin: calculatedCosts.profitMargin
      });
    }

    const updatedOrder = await prisma.transportOrder.update({
      where: { id },
      data: updateData,
      include: {
        location: true,
        truck: true
      }
    });

    // Audit log
    await logDataChange(
      userId,
      'transportOrder',
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

// @route   PUT /api/v1/transport/orders/:id/status
// @desc    Update transport order status
// @access  Private (Transport module access)
router.put('/orders/:id/status',
  authorizeModule('transport', 'write'),
  param('id').custom(validateCuid('order ID')),
  body('deliveryStatus').isIn([
    'PENDING',
    'CONFIRMED',
    'PROCESSING',
    'IN_TRANSIT',
    'DELIVERED',
    'PARTIALLY_DELIVERED',
    'CANCELLED'
  ]).withMessage('Invalid delivery status'),
  body('notes').optional().trim(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { deliveryStatus, notes } = req.body;
    const userId = req.user.id;

    // Get existing order
    const existingOrder = await prisma.transportOrder.findUnique({
      where: { id }
    });

    if (!existingOrder) {
      throw new NotFoundError('Transport order not found');
    }

    // Check permissions - only allow staff to update their own orders unless admin
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      if (existingOrder.createdBy !== userId) {
        throw new BusinessError('You can only update your own orders', 'PERMISSION_DENIED');
      }
    }

    // Update order status
    const updatedOrder = await prisma.transportOrder.update({
      where: { id },
      data: {
        deliveryStatus,
        updatedAt: new Date()
      },
      include: {
        location: true,
        truck: true,
        createdByUser: {
          select: { username: true }
        }
      }
    });

    // Log status change
    await prisma.auditLog.create({
      data: {
        userId,
        action: 'UPDATE',
        entity: 'TransportOrder',
        entityId: id,
        oldValues: { deliveryStatus: existingOrder.deliveryStatus },
        newValues: { deliveryStatus, notes }
      }
    });

    res.json({
      success: true,
      message: 'Order status updated successfully',
      data: { order: updatedOrder }
    });
  })
);

// ================================
// LOCATIONS
// ================================

// @route   GET /api/v1/transport/locations
// @desc    Get all transport locations
// @access  Private
router.get('/locations',
  asyncHandler(async (req, res) => {
    const locations = await prisma.location.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        address: true,
        fuelRequired: true,
        fuelCostPerLitre: true,
        driverWages: true,
        deliveryNotes: true,
        isActive: true,
        createdAt: true,
      }
    });
    res.json({ success: true, data: { locations } });
  })
);

// @route   POST /api/v1/transport/locations
// @desc    Create a transport location
// @access  Private (admin)
router.post('/locations',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  [
    body('name').notEmpty().withMessage('Location name is required'),
    body('fuelRequired').isFloat({ min: 0 }).withMessage('Fuel required must be a positive number'),
    body('driverWages').isFloat({ min: 0 }).withMessage('Driver wages must be a positive number'),
    body('address').optional().trim(),
    body('deliveryNotes').optional().trim(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ValidationError('Invalid input data', errors.array());

    const { name, fuelRequired, driverWages, address, deliveryNotes } = req.body;

    const location = await prisma.location.create({
      data: {
        name,
        fuelRequired: parseFloat(fuelRequired),
        driverWages: parseFloat(driverWages),
        address: address || null,
        deliveryNotes: deliveryNotes || null,
      }
    });

    res.status(201).json({ success: true, message: 'Location created successfully', data: { location } });
  })
);

// @route   PUT /api/v1/transport/locations/:id
// @desc    Update a transport location
// @access  Private (admin)
router.put('/locations/:id',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  [
    body('name').optional().notEmpty().withMessage('Name cannot be empty'),
    body('fuelRequired').optional().isFloat({ min: 0 }),
    body('driverWages').optional().isFloat({ min: 0 }),
    body('address').optional().trim(),
    body('deliveryNotes').optional().trim(),
    body('isActive').optional().isBoolean(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ValidationError('Invalid input data', errors.array());

    const { id } = req.params;
    const { name, fuelRequired, driverWages, address, deliveryNotes, isActive } = req.body;

    const existing = await prisma.location.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Location not found');

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (fuelRequired !== undefined) updateData.fuelRequired = parseFloat(fuelRequired);
    if (driverWages !== undefined) updateData.driverWages = parseFloat(driverWages);
    if (address !== undefined) updateData.address = address;
    if (deliveryNotes !== undefined) updateData.deliveryNotes = deliveryNotes;
    if (isActive !== undefined) updateData.isActive = isActive;

    const location = await prisma.location.update({ where: { id }, data: updateData });
    res.json({ success: true, message: 'Location updated successfully', data: { location } });
  })
);

// @route   DELETE /api/v1/transport/locations/:id
// @desc    Deactivate (soft-delete) a transport location
// @access  Private (admin)
router.delete('/locations/:id',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const existing = await prisma.location.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Location not found');

    await prisma.location.update({ where: { id }, data: { isActive: false } });
    res.json({ success: true, message: 'Location deactivated successfully' });
  })
);

// ================================
// TRANSPORT EXPENSES
// ================================

// @route   POST /api/v1/transport/expenses
// @desc    Create transport expense
// @access  Private (Transport module access)
router.post('/expenses',
  createExpenseValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      truckId,
      locationId,
      expenseType,
      category,
      amount,
      description,
      expenseDate,
      receiptNumber
    } = req.body;

    const userId = req.user.id;

    // Map TRIP/NON_TRIP to actual ExpenseType enum
    const mappedExpenseType = expenseType === 'TRIP' ? 'TRANSPORT_EXPENSE' : 'MAINTENANCE';

    // Normalize category text to enum value
    const normalizeCategory = (cat) => {
      const normalized = cat.trim().toUpperCase().replace(/\s+/g, '_');
      
      const categoryMap = {
        'FUEL': 'FUEL',
        'MAINTENANCE': 'MAINTENANCE',
        'REPAIRS': 'REPAIRS',
        'REPAIR': 'REPAIRS',
        'INSURANCE': 'INSURANCE',
        'DRIVER_WAGES': 'DRIVER_WAGES',
        'DRIVER_WAGE': 'DRIVER_WAGES',
        'WAGES': 'DRIVER_WAGES',
        'SERVICE_CHARGES': 'SERVICE_CHARGES',
        'SERVICE_CHARGE': 'SERVICE_CHARGES',
        'EQUIPMENT': 'EQUIPMENT',
        'UTILITIES': 'UTILITIES',
        'UTILITY': 'UTILITIES',
        'RENT': 'RENT',
        'OFFICE_SUPPLIES': 'OFFICE_SUPPLIES',
        'OFFICE_SUPPLY': 'OFFICE_SUPPLIES',
        'MARKETING': 'MARKETING',
        'TRANSPORT_SERVICE_FEE': 'TRANSPORT_SERVICE_FEE',
        'TOLL': 'OTHER',
        'TOLLS': 'OTHER',
        'PARKING': 'OTHER',
        'TRIP_ALLOWANCE': 'OTHER',
        'MOTOR_BOY_WAGES': 'DRIVER_WAGES',
        'OTHER': 'OTHER'
      };

      return categoryMap[normalized] || 'OTHER';
    };

    const mappedCategory = normalizeCategory(category);

    // Build data object conditionally - only include foreign keys if they're provided AND not empty
    const expenseData = {
      expenseType: mappedExpenseType,
      category: mappedCategory,
      amount: parseFloat(amount),
      description,
      expenseDate: new Date(expenseDate),
      status: 'PENDING',
      createdBy: userId
    };

    // Only add truckId if it's provided and not empty
    if (truckId && truckId.trim() !== '') {
      expenseData.truckId = truckId;
    }

    // Only add locationId if it's provided and not empty
    if (locationId && locationId.trim() !== '') {
      expenseData.locationId = locationId;
    }

    // Only add receiptNumber if provided
    if (receiptNumber && receiptNumber.trim() !== '') {
      expenseData.receiptNumber = receiptNumber;
    }

    const expense = await prisma.expense.create({
      data: expenseData,
      include: {
        truck: { 
          select: { 
            truckId: true, 
            registrationNumber: true 
          } 
        },
        location: { 
          select: { 
            name: true 
          } 
        },
        createdByUser: { 
          select: { 
            username: true 
          } 
        }
      }
    });

    // Audit log
    await logDataChange(
      userId,
      'expense',
      expense.id,
      'CREATE',
      null,
      expense,
      getClientIP(req)
    );

    res.status(201).json({
      success: true,
      message: 'Transport expense created successfully',
      data: { expense }
    });
  })
);

// @route   GET /api/v1/transport/expenses
// @desc    Get transport expenses with filtering
// @access  Private (Transport module access)
router.get('/expenses',
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      status,
      expenseType,
      category,
      truckId,
      startDate,
      endDate
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {
      expenseType: { in: ['TRANSPORT_EXPENSE', 'MAINTENANCE', 'FUEL_COST', 'SALARY_WAGES'] } // Filter for transport-related expenses
    };
    
    if (status) where.status = status;
    if (category) where.category = category;
    if (truckId) where.truckId = truckId;
    
    if (startDate || endDate) {
      where.expenseDate = {};
      if (startDate) where.expenseDate.gte = new Date(startDate);
      if (endDate) where.expenseDate.lte = new Date(endDate);
    }

    const [expenses, total] = await Promise.all([
      prisma.expense.findMany({  // ✅ Changed from transportExpense to expense
        where,
        include: {
          truck: { select: { truckId: true, registrationNumber: true } },
          location: { select: { name: true } },
          createdByUser: { select: { username: true } }
        },
        orderBy: { expenseDate: 'desc' },
        skip,
        take
      }),
      prisma.expense.count({ where })  // ✅ Changed from transportExpense to expense
    ]);

    res.json({
      success: true,
      data: {
        expenses,
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


// @route   GET /api/v1/transport/expenses/:id
// @desc    Get single expense
// @access  Private (Transport module access)
router.get('/expenses/:id',
  param('id').custom(validateCuid('expense ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const expense = await prisma.expense.findUnique({
      where: { id },
      include: {
        truck: { 
          select: { 
            truckId: true, 
            registrationNumber: true,
            make: true,
            model: true 
          } 
        },
        location: { 
          select: { 
            id: true,
            name: true 
          } 
        },
        createdByUser: {
          select: { 
            username: true, 
            role: true 
          } 
        },
        approver: {
          select: { 
            username: true, 
            role: true 
          } 
        }
      }
    });

    if (!expense) {
      throw new NotFoundError('Expense not found');
    }

    // Filter to only return transport-related expenses
    const transportExpenseTypes = ['TRANSPORT_EXPENSE', 'MAINTENANCE', 'FUEL_COST', 'SALARY_WAGES'];
    if (!transportExpenseTypes.includes(expense.expenseType)) {
      throw new NotFoundError('Expense not found');
    }

    res.json({
      success: true,
      data: { expense }
    });
  })
);

// @route   PUT /api/v1/transport/expenses/:id/approve
// @desc    Approve expense (with automatic cash flow)
// @access  Private (Admin only)
router.put('/expenses/:id/approve',
  param('id').custom(validateCuid('expense ID')),
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { notes } = req.body;
    const userId = req.user.id;

    const expense = await prisma.expense.findUnique({
      where: { id },
      include: {
        truck: { select: { truckId: true, registrationNumber: true } },
        location: { select: { name: true } }
      }
    });

    if (!expense) {
      throw new NotFoundError('Expense not found');
    }

    if (expense.status !== 'PENDING') {
      throw new BusinessError('Expense has already been processed', 'INVALID_STATUS');
    }

    // ✨ USE TRANSACTION to approve expense + create cash flow atomically
    const result = await prisma.$transaction(async (tx) => {
      // 1. Update expense status
      const updatedExpense = await tx.expense.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedAt: new Date(),
          approver: {
            connect: { id: userId }
          }
        },
        include: {
          truck: { select: { truckId: true, registrationNumber: true } },
          location: { select: { name: true } },
          createdByUser: { select: { username: true } },
          approver: { select: { username: true } }
        }
      });

      // 2. ✨ AUTOMATICALLY CREATE CASH FLOW ENTRY ✨
      const cashFlowDescription = expense.truck
        ? `Transport Expense: ${expense.category} - Truck ${expense.truck.registrationNumber} (${expense.expenseType.replace(/_/g, ' ')})`
        : `Transport Expense: ${expense.category} - ${expense.location?.name || 'General'} (${expense.expenseType.replace(/_/g, ' ')})`;

      const cashFlowEntry = await tx.cashFlow.create({
        data: {
          transactionType: 'CASH_OUT',
          amount: expense.amount,
          paymentMethod: 'CASH', // Default for transport expenses
          description: cashFlowDescription,
          referenceNumber: expense.receiptNumber || `EXP-${id.slice(0, 8)}`,
          cashier: userId,
    module: 'TRANSPORT'
        }
      });

      console.log('✅ Cash flow entry created for approved transport expense:', {
        transactionType: 'CASH_OUT',
        amount: expense.amount,
        expenseId: id,
        category: expense.category
      });

      return { updatedExpense, cashFlowEntry };
    });

    res.json({
      success: true,
      message: 'Expense approved successfully. Cash flow entry created.',
      data: { 
        expense: result.updatedExpense,
        cashFlowRecorded: true
      }
    });
  })
);

// @route   PUT /api/v1/transport/expenses/:id/reject
// @desc    Reject expense
// @access  Private (Admin only)
router.put('/expenses/:id/reject',
  param('id').custom(validateCuid('expense ID')),
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  body('reason').notEmpty().withMessage('Rejection reason is required'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const userId = req.user.id;

    const expense = await prisma.expense.findUnique({
      where: { id }
    });

    if (!expense) {
      throw new NotFoundError('Expense not found');
    }

    if (expense.status !== 'PENDING') {
      throw new BusinessError('Expense has already been processed', 'INVALID_STATUS');
    }

    // ✅ For rejected expenses, we still use approver relation
    const updatedExpense = await prisma.expense.update({
      where: { id },
      data: {
        status: 'REJECTED',
        approver: {
          connect: { id: userId }
        }
        // Note: The schema doesn't have rejectedAt, rejectedBy, or approvalNotes fields
      },
      include: {
        truck: { select: { truckId: true, registrationNumber: true } },
        location: { select: { name: true } },
        createdByUser: { select: { username: true } },
        approver: { select: { username: true } }
      }
    });

    res.json({
      success: true,
      message: 'Expense rejected',
      data: { expense: updatedExpense }
    });
  })
);

// @route   POST /api/v1/transport/expenses/bulk-approve
// @desc    Bulk approve expenses (with automatic cash flow)
// @access  Private (Transport Admin only)
router.post('/expenses/bulk-approve',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  [
    body('expenseIds').isArray({ min: 1 }).withMessage('Expense IDs array is required'),
    body('action').isIn(['approve', 'reject']).withMessage('Action must be approve or reject'),
    body('rejectionReason').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { expenseIds, action, rejectionReason } = req.body;
    const userId = req.user.id;

    // ✨ USE TRANSACTION to update expenses and create cash flows atomically
    const result = await prisma.$transaction(async (tx) => {
      // Fetch expenses first
      const expenses = await tx.expense.findMany({
        where: {
          id: { in: expenseIds },
          status: 'PENDING',
          expenseType: { in: ['TRANSPORT_EXPENSE', 'MAINTENANCE', 'FUEL_COST', 'SALARY_WAGES'] }
        },
        include: {
          truck: { select: { truckId: true, registrationNumber: true } },
          location: { select: { name: true } }
        }
      });

      if (expenses.length === 0) {
        throw new BusinessError('No pending transport expenses found to update', 'NO_PENDING_EXPENSES');
      }

      // Update all expenses
      await tx.expense.updateMany({
        where: {
          id: { in: expenseIds },
          status: 'PENDING'
        },
        data: {
          status: action === 'approve' ? 'APPROVED' : 'REJECTED',
          approvedAt: new Date()
        }
      });

      // Link approver to each expense individually
      for (const expense of expenses) {
        await tx.expense.update({
          where: { id: expense.id },
          data: {
            approver: { connect: { id: userId } }
          }
        });
      }

      // Create cash flow entries only for approved expenses
      let cashFlowEntries = [];
      if (action === 'approve') {
        for (const expense of expenses) {
          const cashFlowDescription = expense.truck
            ? `Transport Expense: ${expense.category} - Truck ${expense.truck.registrationNumber}`
            : `Transport Expense: ${expense.category} - ${expense.location?.name || 'General'}`;

          const cashFlowEntry = await tx.cashFlow.create({
            data: {
              transactionType: 'CASH_OUT',
              amount: expense.amount,
              paymentMethod: 'CASH',
              description: cashFlowDescription,
              referenceNumber: expense.receiptNumber || `EXP-${expense.id.slice(0, 8)}`,
              cashier: userId,
    module: 'TRANSPORT'
            }
          });

          cashFlowEntries.push(cashFlowEntry);
        }

        console.log(`✅ Created ${cashFlowEntries.length} cash flow entries for bulk approved transport expenses`);
      }

      return { 
        updatedCount: expenses.length,
        cashFlowEntries 
      };
    });

    const successMessage = action === 'approve'
      ? `${result.updatedCount} expense(s) approved successfully. ${result.cashFlowEntries.length} cash flow entry(ies) created.`
      : `${result.updatedCount} expense(s) rejected successfully`;

    res.json({
      success: true,
      message: successMessage,
      data: {
        updatedCount: result.updatedCount,
        action,
        cashFlowRecorded: action === 'approve'
      }
    });
  })
);


// ================================
// CASH FLOW ROUTES (TRANSPORT)
// ================================

// @route   POST /api/v1/transport/cash-flow
// @desc    Create cash flow entry
// @access  Private (Transport Staff, Admin)
router.post('/cash-flow',
  authorizeModule('transport', 'write'),
  [
    body('transactionType').isIn(['CASH_IN', 'CASH_OUT']),
    body('amount').isFloat({ min: 0.01 }),
    body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
    body('description').optional().trim(),
    body('referenceNumber').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      transactionType,
      amount,
      paymentMethod,
      description,
      referenceNumber
    } = req.body;

    const cashFlow = await prisma.cashFlow.create({
      data: {
        transactionType,
        amount: parseFloat(amount),
        paymentMethod,
        description,
        referenceNumber,
        cashier: req.user.id
      },
      include: {
        cashierUser: {
          select: { username: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Cash flow entry created successfully',
      data: { cashFlow }
    });
  })
);

// @route   GET /api/v1/transport/cash-flow
// @desc    Get cash flow entries with filtering
// @access  Private (Transport module access)
router.get('/cash-flow',
  authorizeModule('transport'),
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      transactionType,
      paymentMethod,
      startDate,
      endDate,
      isReconciled
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const where = {};

    if (transactionType) where.transactionType = transactionType;
    if (paymentMethod) where.paymentMethod = paymentMethod;
    
    if (isReconciled !== undefined) {
      where.isReconciled = isReconciled === 'true';
    }

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [entries, total] = await Promise.all([
      prisma.cashFlow.findMany({
        where,
        include: {
          cashierUser: {
            select: { username: true }
          }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      prisma.cashFlow.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        cashFlowEntries: entries,
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

// ================================
// PENDING EXPENSES FOR APPROVAL
// ================================

// @route   GET /api/v1/transport/expenses/pending/approvals
// @desc    Get pending expenses for approval
// @access  Private (Admin only)
router.get('/expenses/pending/approvals',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    const [expenses, total] = await Promise.all([
      prisma.transportExpense.findMany({
        where: { status: 'PENDING' },
        include: {
          truck: { select: { truckId: true, registrationNumber: true } },
          location: { select: { name: true } },
          createdByUser: { select: { username: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      prisma.transportExpense.count({ where: { status: 'PENDING' } })
    ]);

    res.json({
      success: true,
      data: {
        expenses,
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

// @route   GET /api/v1/transport/orders/export/csv
// @desc    Export transport orders to CSV in tabular format
// @access  Private (Transport module access)
router.get('/orders/export/csv',
  asyncHandler(async (req, res) => {
    const { 
      status, 
      locationId,
      truckId,
      startDate, 
      endDate 
    } = req.query;

    const where = {};
    if (status) where.deliveryStatus = status;
    if (locationId) where.locationId = locationId;
    if (truckId) where.truckId = truckId;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const orders = await prisma.transportOrder.findMany({
      where,
      include: {
        location: { select: { name: true } },
        truck: { select: { registrationNumber: true, make: true, model: true } },
        createdByUser: { select: { username: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const fields = [
      { label: 'Order Number', value: 'orderNumber' },
      { label: 'Client Name', value: 'clientName' },
      { label: 'Client Phone', value: 'clientPhone' },
      { label: 'Location', value: 'location.name' },
      { label: 'Truck', value: 'truck.registrationNumber' },
      { label: 'Pallets', value: 'pallets' },
      { label: 'Total Amount (NGN)', value: 'totalOrderAmount' },
      { label: 'Fuel (Liters)', value: 'fuelInLiters' },
      { label: 'Fuel Cost (NGN)', value: 'fuelCost' },
      { label: 'Trip Allowance (NGN)', value: 'tripAllowance' },
      { label: 'Service Charge (NGN)', value: 'serviceCharge' },
      { label: 'Truck Expenses (NGN)', value: 'truckExpenses' },
      { label: 'Truck Expenses Description', value: 'truckExpensesDescription' },
      { label: 'Total Expenses (NGN)', value: 'totalExpenses' },
      { label: 'Net Profit (NGN)', value: 'netProfit' },
      { label: 'Profit Margin (%)', value: 'profitMargin' },
      { label: 'Invoice Number', value: 'invoiceNumber' },
      { label: 'Delivery Status', value: 'deliveryStatus' },
      { label: 'Created By', value: 'createdByUser.username' },
      { label: 'Created At', value: 'createdAt' }
    ];

    const csvData = orders.map(order => ({
      orderNumber: order.orderNumber || `TO-${order.id.slice(-8)}`,
      clientName: order.clientName,
      clientPhone: order.clientPhone || 'N/A',
      'location.name': order.location?.name || 'N/A',
      'truck.registrationNumber': order.truck?.registrationNumber || 'N/A',
      pallets: 'N/A',
      totalOrderAmount: parseFloat(order.totalOrderAmount || 0).toFixed(2),
      fuelInLiters: parseFloat(order.fuelRequired || 0).toFixed(2),
      fuelCost: parseFloat(order.totalFuelCost || 0).toFixed(2),
      tripAllowance: parseFloat(order.tripAllowance || 0).toFixed(2),
      serviceCharge: parseFloat(order.serviceChargeExpense || 0).toFixed(2),
      truckExpenses: parseFloat(order.truckExpenses || 0).toFixed(2),
      truckExpensesDescription: order.truckExpensesDescription || 'N/A',
      totalExpenses: parseFloat(order.totalTripExpenses || 0).toFixed(2),
      netProfit: parseFloat(order.netProfit || 0).toFixed(2),
      profitMargin: parseFloat(order.profitMargin || 0).toFixed(2),
      invoiceNumber: order.invoiceNumber || 'N/A',
      deliveryStatus: order.deliveryStatus,
      'createdByUser.username': order.createdByUser?.username || 'N/A',
      createdAt: new Date(order.createdAt).toLocaleString('en-NG')
    }));

    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=transport-orders-${new Date().toISOString().split('T')[0]}.csv`);
    res.send('\uFEFF' + csv); // Add BOM for Excel compatibility
  })
);

// @route   GET /api/v1/transport/orders/export/pdf
// @desc    Export transport orders to beautifully formatted PDF table
// @access  Private (Transport module access)
router.get('/orders/export/pdf',
  [
    query('startDate').optional().isISO8601().withMessage('Invalid start date'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date'),
    query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit must be between 1 and 1000'),
    query('all').optional().isBoolean().withMessage('All must be boolean'),
    query('status').optional(),
    query('locationId').optional(),
    query('truckId').optional()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { 
      status, 
      locationId,
      truckId,
      startDate, 
      endDate,
      limit,
      all
    } = req.query;

    // Build where clause
    const where = {};
    if (status) where.deliveryStatus = status;
    if (locationId) where.locationId = locationId;
    if (truckId) where.truckId = truckId;

    // Date range handling
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    // Query options
    const queryOptions = {
      where,
      include: {
        location: { select: { name: true } },
        truck: { select: { registrationNumber: true } }
      },
      orderBy: { createdAt: 'desc' }
    };

    // Apply limit
    if (limit && !startDate && !endDate && all !== 'true') {
      queryOptions.take = parseInt(limit);
    } else if (!startDate && !endDate && all !== 'true') {
      queryOptions.take = 100; // Default: last 100 orders
    }

    const orders = await prisma.transportOrder.findMany(queryOptions);

    const doc = new PDFDocument({ 
      margin: 30, 
      size: 'A4', 
      layout: 'landscape'
    });
    
    // Generate filename
    let filename = 'transport-orders';
    if (startDate && endDate) {
      filename = `transport-orders-${startDate}-to-${endDate}.pdf`;
    } else if (limit) {
      filename = `transport-orders-last-${limit}.pdf`;
    } else if (all === 'true') {
      filename = `transport-orders-all-${new Date().toISOString().split('T')[0]}.pdf`;
    } else {
      filename = `transport-orders-${new Date().toISOString().split('T')[0]}.pdf`;
    }
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    doc.pipe(res);

    // Header with styling
    doc.fontSize(20)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('TRANSPORT ORDERS REPORT', { align: 'center' });
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#666')
       .text(`Generated on ${new Date().toLocaleString('en-NG', { 
         dateStyle: 'full', 
         timeStyle: 'short' 
       })}`, { align: 'center' });
    
    // Export criteria info
    doc.fontSize(9).fillColor('#666');
    
    if (startDate && endDate) {
      doc.text(`Period: ${startDate} to ${endDate}`, { align: 'center' });
    } else if (limit) {
      doc.text(`Showing last ${limit} orders`, { align: 'center' });
    } else if (all === 'true') {
      doc.text(`All orders`, { align: 'center' });
    }

    doc.moveDown(1.5);

    // Calculate totals
    let totalRevenue = 0;
    let totalExpenses = 0;
    let totalProfit = 0;
    let totalFuel = 0;

    orders.forEach(order => {
      totalRevenue += parseFloat(order.totalOrderAmount || 0);
      totalExpenses += parseFloat(order.totalTripExpenses || 0);
      totalProfit += parseFloat(order.netProfit || 0);
      totalFuel += parseFloat(order.fuelRequired || 0);
    });

    // Table data
    const tableData = {
      headers: [
        'Order #',
        'Client',
        'Location',
        'Truck',
        'Pallets',
        'Revenue (NGN)',
        'Fuel (L)',
        'Expenses (NGN)',
        'Profit (NGN)',
        'Margin %',
        'Status'
      ],
      rows: orders.map(order => [
        order.orderNumber || `TO-${order.id.slice(-8)}`,
        order.clientName?.substring(0, 15) || 'N/A',
        order.location?.name?.substring(0, 12) || 'N/A',
        order.truck?.registrationNumber || 'N/A',
        'N/A',
        parseFloat(order.totalOrderAmount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        parseFloat(order.fuelRequired || 0).toFixed(1),
        parseFloat(order.totalTripExpenses || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        parseFloat(order.netProfit || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        parseFloat(order.profitMargin || 0).toFixed(1),
        order.deliveryStatus || 'N/A'
      ])
    };

    // Column sizes
    const columnSizes = [55, 80, 65, 60, 45, 75, 45, 75, 75, 50, 70];

    doc.table(tableData, {
      prepareHeader: () => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
      },
      prepareRow: (row, indexColumn, indexRow, rectRow, rectCell) => {
        doc.font('Helvetica').fontSize(8).fillColor('#000');
      },
      padding: 6,
      columnSpacing: 4,
      columnsSize: columnSizes,
      x: 30,
      width: doc.page.width - 60,
      headerRows: 1,
      divider: {
        header: { disabled: false, width: 1.5, opacity: 1, color: '#000' },
        horizontal: { disabled: false, width: 0.5, opacity: 1, color: '#000' }
      }
    });

    doc.moveDown(1);

    // Footer with totals
    doc.fontSize(10)
       .font('Helvetica-Bold')
       .fillColor('#000')
       .text('TOTALS', 40, doc.y);
    
    doc.moveDown(0.3);
    
    doc.fontSize(9)
       .font('Helvetica')
       .fillColor('#000');
    
    const footerY = doc.y;
    doc.text(`Revenue: NGN ${totalRevenue.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 40, footerY);
    doc.text(`Expenses: NGN ${totalExpenses.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 220, footerY);
    doc.text(`Profit: NGN ${totalProfit.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 400, footerY);
    doc.text(`Fuel: ${totalFuel.toFixed(1)} L`, 600, footerY);

    // Page footer
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#666')
       .text(
         `Premium G Enterprise - Transport Report | ${orders.length} Orders`,
         30,
         doc.page.height - 40,
         { align: 'center', width: doc.page.width - 60 }
       );

    doc.end();
  })
);

// @route   GET /api/v1/transport/orders/:id/export/pdf
// @desc    Export single transport order as beautifully formatted PDF
// @access  Private (Transport module access)
router.get('/orders/:id/export/pdf',
  param('id').custom(validateCuid('order ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;

    const order = await prisma.transportOrder.findUnique({
      where: { id },
      include: {
        location: true,
        truck: true,
        createdByUser: { select: { username: true } }
      }
    });

    if (!order) {
      throw new NotFoundError('Transport order not found');
    }

    const doc = new PDFDocument({ 
      margin: 50, 
      size: 'A4'
    });
    
    const filename = `transport-order-${order.orderNumber || order.id.slice(-8)}-${new Date().toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    doc.pipe(res);

    // ===== HEADER SECTION =====
    doc.rect(0, 0, doc.page.width, 120)
       .fill('#1e40af');

    doc.fontSize(28)
       .font('Helvetica-Bold')
       .fillColor('#ffffff')
       .text('PREMIUM G ENTERPRISE', 50, 30);
    
    doc.fontSize(11)
       .font('Helvetica')
       .fillColor('#e0e7ff')
       .text('Transport Order Invoice', 50, 65);
    
    // Order number and date on right
    doc.fontSize(10)
       .fillColor('#ffffff')
       .text(`Order #: ${order.orderNumber || `TO-${order.id.slice(-8)}`}`, 400, 40, { align: 'right' });
    
    doc.fontSize(9)
       .fillColor('#e0e7ff')
       .text(`Date: ${new Date(order.createdAt).toLocaleDateString('en-NG', { 
         year: 'numeric', 
         month: 'long', 
         day: 'numeric' 
       })}`, 400, 60, { align: 'right' });

    // Status badge
    const statusColor = 
      order.deliveryStatus === 'DELIVERED' ? '#10b981' :
      order.deliveryStatus === 'IN_TRANSIT' ? '#3b82f6' :
      order.deliveryStatus === 'CONFIRMED' ? '#f59e0b' :
      '#ef4444';

    doc.rect(400, 85, 145, 20)
       .fill(statusColor);
    
    doc.fontSize(10)
       .fillColor('#ffffff')
       .text(order.deliveryStatus || 'PENDING', 400, 90, { align: 'center', width: 145 });

    doc.fillColor('#000000'); // Reset to black

    // ===== CLIENT INFORMATION =====
    let yPos = 150;
    
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('CLIENT INFORMATION', 50, yPos);
    
    yPos += 25;
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');
    
    const clientInfo = [
      ['Client Name:', order.clientName],
      ['Phone:', order.clientPhone || 'N/A'],
      ['Location:', order.location?.name || 'N/A'],
      ['Address:', order.location?.address || 'N/A']
    ];

    clientInfo.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
      doc.font('Helvetica').text(value, { width: 350 });
      yPos += 20;
    });

    // ===== TRANSPORT DETAILS =====
    yPos += 15;
    
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('TRANSPORT DETAILS', 50, yPos);
    
    yPos += 25;
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');

    const transportInfo = [
      ['Truck:', order.truck?.registrationNumber || 'N/A'],
      ['Truck Make/Model:', `${order.truck?.make || 'N/A'} ${order.truck?.model || ''}`],
      ['Pallets:', order.pallets?.toString() || '0'],
      ['Invoice Number:', order.invoiceNumber || 'N/A']
    ];

    transportInfo.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
      doc.font('Helvetica').text(value, { width: 350 });
      yPos += 20;
    });

    // ===== FINANCIAL BREAKDOWN =====
    yPos += 15;
    
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('FINANCIAL BREAKDOWN', 50, yPos);
    
    yPos += 25;

    // Revenue section
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .fillColor('#000')
       .text('REVENUE', 50, yPos);
    
    yPos += 20;

    doc.fontSize(10)
       .font('Helvetica');
    
    doc.text('Total Order Amount:', 70, yPos, { width: 200, continued: true });
    doc.font('Helvetica-Bold')
       .text(`NGN ${parseFloat(order.totalOrderAmount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, { align: 'right', width: 280 });
    
    yPos += 30;

    // Expenses section
    doc.fontSize(11)
       .font('Helvetica-Bold')
       .fillColor('#000')
       .text('EXPENSES', 50, yPos);
    
    yPos += 20;

    const expenses = [
      ['Fuel Cost:', order.totalFuelCost, `(${parseFloat(order.fuelRequired || 0).toFixed(1)} liters @ NGN ${parseFloat(order.fuelPricePerLiter || 0).toFixed(2)}/L)`],
      ['Driver Wages:', order.driverWages],
      ['Trip Allowance:', order.tripAllowance],
      ['Service Charge (10%):', order.serviceChargeExpense],
      ['Truck Expenses:', order.truckExpenses, order.truckExpensesDescription || ''],  // ADD THIS LINE
      ['Total Expenses:', order.totalTripExpenses, '', true]
    ];

    doc.fontSize(10).font('Helvetica');

    expenses.forEach(([label, amount, note, isBold]) => {
      if (isBold) {
        doc.font('Helvetica-Bold');
      } else {
        doc.font('Helvetica');
      }
      
      doc.text(label, 70, yPos, { width: 150, continued: true });
      doc.text(`NGN ${parseFloat(amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, { align: 'right', width: 200 });
      
      if (note) {
        doc.fontSize(8)
           .fillColor('#666')
           .text(note, 70, yPos + 12);
        yPos += 10;
        doc.fontSize(10).fillColor('#000');
      }
      
      yPos += 20;
    });

    // Profit section - highlighted
    yPos += 10;
    
    doc.rect(50, yPos - 5, doc.page.width - 100, 35)
       .fillAndStroke('#f0f9ff', '#1e40af');
    
    doc.fontSize(12)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('NET PROFIT:', 70, yPos + 5, { width: 150, continued: true });
    
    doc.fontSize(14)
       .text(`NGN ${parseFloat(order.netProfit || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, { align: 'right', width: 280 });
    
    doc.fontSize(9)
       .font('Helvetica')
       .fillColor('#666')
       .text(`Profit Margin: ${parseFloat(order.profitMargin || 0).toFixed(2)}%`, 70, yPos + 22);

    yPos += 50;

    // ===== ADDITIONAL INFORMATION =====
    if (yPos > 650) {
      doc.addPage();
      yPos = 50;
    }

    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('ADDITIONAL INFORMATION', 50, yPos);
    
    yPos += 25;

    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');

    const additionalInfo = [
      ['Created By:', order.createdByUser?.username || 'N/A'],
      ['Created At:', new Date(order.createdAt).toLocaleString('en-NG')],
      ['Last Updated:', new Date(order.updatedAt).toLocaleString('en-NG')]
    ];

    additionalInfo.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
      doc.font('Helvetica').text(value, { width: 350 });
      yPos += 20;
    });

    // ===== FOOTER =====
    const footerY = doc.page.height - 80;
    
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#666')
       .text('Premium G Enterprise - Transport Division', 50, footerY, { align: 'center', width: doc.page.width - 100 });
    
    doc.text('This is a computer-generated document', 50, footerY + 15, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  })
);

// @route   GET /api/v1/transport/expenses/export/csv
// @desc    Export transport expenses to CSV
// @access  Private (Transport module access)
router.get('/expenses/export/csv',
  asyncHandler(async (req, res) => {
    const { 
      status,
      expenseType,
      category,
      truckId,
      startDate, 
      endDate 
    } = req.query;

    const where = {};
    if (status) where.status = status;
    if (expenseType) where.expenseType = expenseType;
    if (category) where.category = category;
    if (truckId) where.truckId = truckId;

    if (startDate || endDate) {
      where.expenseDate = {};
      if (startDate) where.expenseDate.gte = new Date(startDate);
      if (endDate) where.expenseDate.lte = new Date(endDate);
    }

    const expenses = await prisma.transportExpense.findMany({
      where,
      include: {
        truck: { select: { registrationNumber: true } },
        location: { select: { name: true } },
        createdByUser: { select: { username: true } },
        approvedByUser: { select: { username: true } }
      },
      orderBy: { expenseDate: 'desc' }
    });

    const fields = [
      { label: 'Expense Type', value: 'expenseType' },
      { label: 'Category', value: 'category' },
      { label: 'Amount (NGN)', value: 'amount' },
      { label: 'Description', value: 'description' },
      { label: 'Expense Date', value: 'expenseDate' },
      { label: 'Truck', value: 'truck.registrationNumber' },
      { label: 'Location', value: 'location.name' },
      { label: 'Status', value: 'status' },
      { label: 'Created By', value: 'createdByUser.username' },
      { label: 'Approved By', value: 'approvedByUser.username' },
      { label: 'Approved At', value: 'approvedAt' }
    ];

    const csvData = expenses.map(expense => ({
      expenseType: expense.expenseType,
      category: expense.category,
      amount: parseFloat(expense.amount || 0).toFixed(2),
      description: expense.description || 'N/A',
      expenseDate: new Date(expense.expenseDate).toLocaleDateString('en-NG'),
      'truck.registrationNumber': expense.truck?.registrationNumber || 'N/A',
      'location.name': expense.location?.name || 'N/A',
      status: expense.status,
      'createdByUser.username': expense.createdByUser?.username || 'N/A',
      'approvedByUser.username': expense.approvedByUser?.username || 'N/A',
      approvedAt: expense.approvedAt ? new Date(expense.approvedAt).toLocaleString('en-NG') : 'N/A'
    }));

    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=transport-expenses-${new Date().toISOString().split('T')[0]}.csv`);
    res.send('\uFEFF' + csv);
  })
);

// @route   GET /api/v1/transport/expenses/export/pdf
// @desc    Export transport expenses to PDF
// @access  Private (Transport module access)
router.get('/expenses/export/pdf',
  asyncHandler(async (req, res) => {
    const { 
      status,
      expenseType,
      category,
      startDate, 
      endDate 
    } = req.query;

    const where = {};
    if (status) where.status = status;
    if (expenseType) where.expenseType = expenseType;
    if (category) where.category = category;

    if (startDate || endDate) {
      where.expenseDate = {};
      if (startDate) where.expenseDate.gte = new Date(startDate);
      if (endDate) where.expenseDate.lte = new Date(endDate);
    }

    const expenses = await prisma.transportExpense.findMany({
      where,
      include: {
        truck: { select: { registrationNumber: true } },
        location: { select: { name: true } },
        createdByUser: { select: { username: true } }
      },
      orderBy: { expenseDate: 'desc' }
    });

    const doc = new PDFDocument({ 
      margin: 30, 
      size: 'A4', 
      layout: 'landscape'
    });
    
    const filename = `transport-expenses-${new Date().toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    doc.pipe(res);

    doc.fontSize(20)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('TRANSPORT EXPENSES REPORT', { align: 'center' });
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#666')
       .text(`Generated on ${new Date().toLocaleString('en-NG')}`, { align: 'center' });

    doc.moveDown(1.5);

    let totalAmount = 0;
    expenses.forEach(e => totalAmount += parseFloat(e.amount || 0));

    const tableData = {
      headers: [
        'Date',
        'Type',
        'Category',
        'Truck',
        'Amount (NGN)',
        'Status',
        'Created By'
      ],
      rows: expenses.map(expense => [
        new Date(expense.expenseDate).toLocaleDateString('en-NG'),
        expense.expenseType,
        expense.category,
        expense.truck?.registrationNumber || 'N/A',
        parseFloat(expense.amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        expense.status,
        expense.createdByUser?.username || 'N/A'
      ])
    };

    const columnSizes = [70, 80, 90, 70, 90, 70, 80];

    doc.table(tableData, {
      prepareHeader: () => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#000');
      },
      prepareRow: (row, indexColumn, indexRow, rectRow, rectCell) => {
        doc.font('Helvetica').fontSize(8).fillColor('#000');
      },
      padding: 6,
      columnSpacing: 4,
      columnsSize: columnSizes,
      x: 30,
      width: doc.page.width - 60,
      headerRows: 1,
      divider: {
        header: { disabled: false, width: 1.5, opacity: 1, color: '#000' },
        horizontal: { disabled: false, width: 0.5, opacity: 1, color: '#000' }
      }
    });

    doc.moveDown(1);

    // Footer with totals
    doc.fontSize(10)
       .font('Helvetica-Bold')
       .fillColor('#000')
       .text(`TOTAL EXPENSES: NGN ${totalAmount.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`, 40, doc.y);
    
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#666')
       .text(
         `Premium G Enterprise - Transport Expenses | ${expenses.length} Expenses`,
         30,
         doc.page.height - 40,
         { align: 'center', width: doc.page.width - 60 }
       );

    doc.end();
  })
);


// ================================
// SALES (ORDERS) EXPORT ROUTES
// ================================

// @route   GET /api/v1/transport/sales/export/csv
// @desc    Export transport sales (orders) to CSV with filters
// @access  Private (Transport module access)
router.get('/sales/export/csv',
  authorizeModule('transport'),
  [
    query('period').optional().isIn(['day', 'week', 'month', 'year', 'custom']),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('status').optional(),
    query('locationId').optional()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { period, startDate, endDate, status, locationId } = req.query;
    
    const where = {};
    
    // Date filtering based on period
    if (period && period !== 'custom') {
      const now = new Date();
      where.createdAt = {};
      
      switch(period) {
        case 'day':
          where.createdAt.gte = new Date(now.setHours(0,0,0,0));
          break;
        case 'week':
          const weekStart = new Date(now);
          weekStart.setDate(now.getDate() - now.getDay());
          weekStart.setHours(0,0,0,0);
          where.createdAt.gte = weekStart;
          break;
        case 'month':
          where.createdAt.gte = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'year':
          where.createdAt.gte = new Date(now.getFullYear(), 0, 1);
          break;
      }
    } else if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    
    if (status) where.deliveryStatus = status;
    if (locationId) where.locationId = locationId;

    const orders = await prisma.transportOrder.findMany({
      where,
      include: {
        location: { select: { name: true } },
        truck: { select: { registrationNumber: true } },
        createdByUser: { select: { username: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const fields = [
      { label: 'Order Number', value: 'orderNumber' },
      { label: 'Client Name', value: 'clientName' },
      { label: 'Client Phone', value: 'clientPhone' },
      { label: 'Pickup Location', value: 'pickupLocation' },
      { label: 'Delivery Address', value: 'deliveryAddress' },
      { label: 'Location', value: 'location' },
      { label: 'Truck', value: 'truck' },
      { label: 'Total Amount (NGN)', value: 'totalOrderAmount' },
      { label: 'Fuel Required (L)', value: 'fuelRequired' },
      { label: 'Fuel Cost (NGN)', value: 'fuelCost' },
      { label: 'Driver Wages (NGN)', value: 'driverWages' },
      { label: 'Trip Allowance (NGN)', value: 'tripAllowance' },
      { label: 'Service Charge (NGN)', value: 'serviceCharge' },
      { label: 'Truck Expenses (NGN)', value: 'truckExpenses' },
      { label: 'Total Expenses (NGN)', value: 'totalExpenses' },
      { label: 'Net Profit (NGN)', value: 'netProfit' },
      { label: 'Profit Margin (%)', value: 'profitMargin' },
      { label: 'Delivery Status', value: 'deliveryStatus' },
      { label: 'Created By', value: 'createdBy' },
      { label: 'Created At', value: 'createdAt' }
    ];

    const csvData = orders.map(order => ({
      orderNumber: order.orderNumber || `TO-${order.id.slice(-8)}`,
      clientName: order.clientName,
      clientPhone: order.clientPhone || 'N/A',
      pickupLocation: order.pickupLocation,
      deliveryAddress: order.deliveryAddress,
      location: order.location?.name || 'N/A',
      truck: order.truck?.registrationNumber || 'N/A',
      totalOrderAmount: parseFloat(order.totalOrderAmount || 0).toFixed(2),
      fuelRequired: parseFloat(order.fuelRequired || 0).toFixed(2),
      fuelCost: parseFloat(order.fuelCost || 0).toFixed(2),
      driverWages: parseFloat(order.driverWages || 0).toFixed(2),
      tripAllowance: parseFloat(order.tripAllowance || 0).toFixed(2),
      serviceCharge: parseFloat(order.serviceChargeExpense || 0).toFixed(2),
      truckExpenses: parseFloat(order.truckExpenses || 0).toFixed(2),
      totalExpenses: parseFloat(order.totalTripExpenses || 0).toFixed(2),
      netProfit: parseFloat(order.netProfit || 0).toFixed(2),
      profitMargin: parseFloat(order.profitMargin || 0).toFixed(2),
      deliveryStatus: order.deliveryStatus,
      createdBy: order.createdByUser?.username || 'N/A',
      createdAt: new Date(order.createdAt).toLocaleString('en-NG')
    }));

    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=transport-sales-${new Date().toISOString().split('T')[0]}.csv`);
    res.send('\uFEFF' + csv);
  })
);

// @route   GET /api/v1/transport/sales/export/pdf
// @desc    Export transport sales to PDF with filters
// @access  Private (Transport module access)
router.get('/sales/export/pdf',
  authorizeModule('transport'),
  [
    query('period').optional().isIn(['day', 'week', 'month', 'year', 'custom']),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('status').optional(),
    query('locationId').optional(),
    query('limit').optional().isInt({ min: 1, max: 1000 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { period, startDate, endDate, status, locationId, limit = 100 } = req.query;
    
    const where = {};
    
    // Date filtering based on period
    if (period && period !== 'custom') {
      const now = new Date();
      where.createdAt = {};
      
      switch(period) {
        case 'day':
          where.createdAt.gte = new Date(now.setHours(0,0,0,0));
          break;
        case 'week':
          const weekStart = new Date(now);
          weekStart.setDate(now.getDate() - now.getDay());
          weekStart.setHours(0,0,0,0);
          where.createdAt.gte = weekStart;
          break;
        case 'month':
          where.createdAt.gte = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'year':
          where.createdAt.gte = new Date(now.getFullYear(), 0, 1);
          break;
      }
    } else if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    
    if (status) where.deliveryStatus = status;
    if (locationId) where.locationId = locationId;

    const orders = await prisma.transportOrder.findMany({
      where,
      take: parseInt(limit),
      include: {
        location: { select: { name: true } },
        truck: { select: { registrationNumber: true } },
        createdByUser: { select: { username: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const doc = new PDFDocument({ 
      margin: 30, 
      size: 'A4', 
      layout: 'landscape'
    });
    
    const filename = `transport-sales-${new Date().toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    doc.pipe(res);

    // Header
    doc.fontSize(20)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('TRANSPORT SALES REPORT', { align: 'center' });
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#666')
       .text(`Generated on ${new Date().toLocaleString('en-NG')}`, { align: 'center' });

    if (period || startDate || endDate) {
      let periodText = '';
      if (period && period !== 'custom') {
        periodText = `Period: ${period.charAt(0).toUpperCase() + period.slice(1)}`;
      } else if (startDate || endDate) {
        periodText = `Period: ${startDate ? new Date(startDate).toLocaleDateString() : 'Start'} - ${endDate ? new Date(endDate).toLocaleDateString() : 'End'}`;
      }
      doc.text(periodText, { align: 'center' });
    }

    doc.moveDown(1.5);

    // Calculate totals
    let totalRevenue = 0;
    let totalExpenses = 0;
    let totalProfit = 0;
    
    orders.forEach(order => {
      totalRevenue += parseFloat(order.totalOrderAmount || 0);
      totalExpenses += parseFloat(order.totalTripExpenses || 0);
      totalProfit += parseFloat(order.netProfit || 0);
    });

    // Summary Box
    const summaryY = doc.y;
    doc.fontSize(12)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('SUMMARY', 50, summaryY);
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');
    
    const summaryData = [
      ['Total Orders:', orders.length],
      ['Total Revenue:', `NGN ${totalRevenue.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Total Expenses:', `NGN ${totalExpenses.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Net Profit:', `NGN ${totalProfit.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Profit Margin:', `${totalRevenue > 0 ? ((totalProfit / totalRevenue) * 100).toFixed(2) : 0}%`]
    ];

    let yPos = summaryY + 20;
    summaryData.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
      doc.font('Helvetica').text(String(value), { width: 200 });
      yPos += 15;
    });

    doc.moveDown(2);

    // Table
    const tableData = {
      headers: [
        'Order #',
        'Client',
        'Location',
        'Revenue (NGN)',
        'Expenses (NGN)',
        'Profit (NGN)',
        'Margin %',
        'Status'
      ],
      rows: orders.map(order => [
  order.orderNumber || `TO-${order.id.slice(-8)}`,
  order.clientName ? order.clientName.substring(0, 20) : 'N/A',  // ✅ FIXED LINE 2463
  order.location?.name?.substring(0, 15) || 'N/A',
  parseFloat(order.totalOrderAmount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
  parseFloat(order.totalTripExpenses || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
  parseFloat(order.netProfit || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
  parseFloat(order.profitMargin || 0).toFixed(2),
  order.deliveryStatus
])
    };

    const tableTop = doc.y;
    const colWidths = [70, 80, 80, 90, 90, 90, 60, 90];
    const rowHeight = 25;
    let currentY = tableTop;

    // Table Header
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .fillColor('#fff');
    
    doc.rect(30, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
       .fill('#1e40af');

    let xPos = 35;
    tableData.headers.forEach((header, i) => {
      doc.text(header, xPos, currentY + 8, { 
        width: colWidths[i] - 10, 
        align: 'left' 
      });
      xPos += colWidths[i];
    });

    currentY += rowHeight;

    // Table Rows
    doc.font('Helvetica')
       .fontSize(8)
       .fillColor('#000');

    tableData.rows.forEach((row, rowIndex) => {
      if (currentY > 500) {
        doc.addPage({ layout: 'landscape' });
        currentY = 50;
      }

      // Alternating row colors
      if (rowIndex % 2 === 0) {
        doc.rect(30, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
           .fill('#f3f4f6');
      }

      xPos = 35;
      row.forEach((cell, i) => {
        doc.fillColor('#000')
           .text(String(cell), xPos, currentY + 8, { 
             width: colWidths[i] - 10, 
             align: i >= 3 && i <= 6 ? 'right' : 'left' 
           });
        xPos += colWidths[i];
      });

      currentY += rowHeight;
    });

    // Footer
    const footerY = doc.page.height - 80;
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#666')
       .text('Premium G Enterprise - Transport Division', 50, footerY, { 
         align: 'center', 
         width: doc.page.width - 100 
       });
    
    doc.text('This is a computer-generated document', 50, footerY + 15, { 
      align: 'center', 
      width: doc.page.width - 100 
    });

    doc.end();
  })
);

// ================================
// CASH FLOW EXPORT ROUTES (TRANSPORT)
// ================================

// @route   GET /api/v1/transport/cash-flow/export/csv
// @desc    Export transport cash flow to CSV
// @access  Private (Transport module access)
router.get('/cash-flow/export/csv',
  authorizeModule('transport'),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('transactionType').optional().isIn(['CASH_IN', 'CASH_OUT', 'SALE']),
    query('paymentMethod').optional()
  ],
  asyncHandler(async (req, res) => {
    const { startDate, endDate, transactionType, paymentMethod } = req.query;
    
    const where = { module: 'TRANSPORT' };
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    
    if (transactionType) where.transactionType = transactionType;
    if (paymentMethod) where.paymentMethod = paymentMethod;

    const cashFlows = await prisma.cashFlow.findMany({
      where,
      include: {
        cashierUser: { select: { username: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const fields = [
      { label: 'Transaction Type', value: 'transactionType' },
      { label: 'Amount (NGN)', value: 'amount' },
      { label: 'Payment Method', value: 'paymentMethod' },
      { label: 'Description', value: 'description' },
      { label: 'Reference Number', value: 'referenceNumber' },
      { label: 'Cashier', value: 'cashier' },
      { label: 'Reconciled', value: 'isReconciled' },
      { label: 'Created At', value: 'createdAt' }
    ];

    const csvData = cashFlows.map(cf => ({
      transactionType: cf.transactionType,
      amount: parseFloat(cf.amount).toFixed(2),
      paymentMethod: cf.paymentMethod,
      description: cf.description || 'N/A',
      referenceNumber: cf.referenceNumber || 'N/A',
      cashier: cf.cashierUser?.username || 'N/A',
      isReconciled: cf.isReconciled ? 'Yes' : 'No',
      createdAt: new Date(cf.createdAt).toLocaleString('en-NG')
    }));

    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=transport-cashflow-${new Date().toISOString().split('T')[0]}.csv`);
    res.send('\uFEFF' + csv);
  })
);

// @route   GET /api/v1/transport/cash-flow/export/pdf
// @desc    Export transport cash flow to PDF
// @access  Private (Transport module access)
router.get('/cash-flow/export/pdf',
  authorizeModule('transport'),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('transactionType').optional(),
    query('paymentMethod').optional()
  ],
  asyncHandler(async (req, res) => {
    const { startDate, endDate, transactionType, paymentMethod } = req.query;
    
    const where = { module: 'TRANSPORT' };
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    
    if (transactionType) where.transactionType = transactionType;
    if (paymentMethod) where.paymentMethod = paymentMethod;

    const cashFlows = await prisma.cashFlow.findMany({
      where,
      include: {
        cashierUser: { select: { username: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const doc = new PDFDocument({ 
      margin: 30, 
      size: 'A4', 
      layout: 'portrait'
    });
    
    const filename = `transport-cashflow-${new Date().toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    doc.pipe(res);

    // Header
    doc.fontSize(20)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('TRANSPORT CASH FLOW REPORT', { align: 'center' });
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#666')
       .text(`Generated on ${new Date().toLocaleString('en-NG')}`, { align: 'center' });

    doc.moveDown(1.5);

    // Calculate totals
    let totalCashIn = 0;
    let totalCashOut = 0;
    
    cashFlows.forEach(cf => {
      if (cf.transactionType === 'CASH_IN' || cf.transactionType === 'SALE') {
        totalCashIn += parseFloat(cf.amount);
      } else {
        totalCashOut += parseFloat(cf.amount);
      }
    });

    const netCashFlow = totalCashIn - totalCashOut;

    // Summary
    doc.fontSize(12)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('SUMMARY', 50);
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');
    
    let yPos = doc.y + 10;
    const summaryData = [
      ['Total Cash In:', `NGN ${totalCashIn.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Total Cash Out:', `NGN ${totalCashOut.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Net Cash Flow:', `NGN ${netCashFlow.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Total Transactions:', cashFlows.length]
    ];

    summaryData.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
      doc.font('Helvetica').text(value, { width: 350 });
      yPos += 20;
    });

    doc.moveDown(2);

    // Table
    const tableData = {
      headers: ['Date', 'Type', 'Amount (NGN)', 'Method', 'Description', 'Cashier'],
      rows: cashFlows.map(cf => [
        new Date(cf.createdAt).toLocaleDateString('en-NG'),
        cf.transactionType,
        parseFloat(cf.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        cf.paymentMethod,
        (cf.description || 'N/A').substring(0, 30),
        cf.cashierUser?.username || 'N/A'
      ])
    };

    const tableTop = doc.y;
    const colWidths = [70, 70, 90, 70, 120, 80];
    const rowHeight = 30;
    let currentY = tableTop;

    // Table Header
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .fillColor('#fff');
    
    doc.rect(30, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
       .fill('#1e40af');

    let xPos = 35;
    tableData.headers.forEach((header, i) => {
      doc.text(header, xPos, currentY + 10, { 
        width: colWidths[i] - 10, 
        align: 'left' 
      });
      xPos += colWidths[i];
    });

    currentY += rowHeight;

    // Table Rows
    doc.font('Helvetica')
       .fontSize(8)
       .fillColor('#000');

    tableData.rows.forEach((row, rowIndex) => {
      if (currentY > 700) {
        doc.addPage();
        currentY = 50;
      }

      if (rowIndex % 2 === 0) {
        doc.rect(30, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
           .fill('#f3f4f6');
      }

      xPos = 35;
      row.forEach((cell, i) => {
        doc.fillColor('#000')
           .text(String(cell), xPos, currentY + 10, { 
             width: colWidths[i] - 10, 
             align: i === 2 ? 'right' : 'left' 
           });
        xPos += colWidths[i];
      });

      currentY += rowHeight;
    });

    // Footer
    const footerY = doc.page.height - 80;
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#666')
       .text('Premium G Enterprise - Transport Division', 50, footerY, { 
         align: 'center', 
         width: doc.page.width - 100 
       });

    doc.end();
  })
);

module.exports = router;

