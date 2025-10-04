// routes/transport.js - COMPLETE FIXED VERSION

const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { Parser } = require('json2csv');
const PDFDocument = require('pdfkit-table');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

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
  body('pickupLocation').notEmpty().withMessage('Pickup location is required'),
  body('deliveryAddress').notEmpty().withMessage('Delivery address is required'),
  body('locationId').notEmpty().custom(validateCuid('location ID')),
  body('totalOrderAmount').isFloat({ min: 0 }).withMessage('Order amount must be positive'),
  body('fuelRequired').isFloat({ min: 0 }).withMessage('Fuel required must be positive'),
  body('fuelPricePerLiter').isFloat({ min: 0 }).withMessage('Fuel price must be positive'),
  body('truckId').optional().custom(validateCuid('truck ID')),
  body('driverDetails').optional().trim(),
  body('invoiceNumber').optional().trim()
];

const updateTransportOrderValidation = [
  body('clientName').optional().notEmpty(),
  body('pickupLocation').optional().notEmpty(),
  body('deliveryAddress').optional().notEmpty(),
  body('totalOrderAmount').optional().isFloat({ min: 0 }),
  body('fuelRequired').optional().isFloat({ min: 0 }),
  body('fuelPricePerLiter').optional().isFloat({ min: 0 }),
  body('truckId').optional().custom(validateCuid('truck ID')),
  body('driverDetails').optional().trim()
];

const createExpenseValidation = [
  body('truckId').optional().custom(validateCuid('truck ID')),
  body('locationId').optional().custom(validateCuid('location ID')),
  body('expenseType').isIn(['TRIP', 'NON_TRIP']).withMessage('Invalid expense type'),
  body('category').notEmpty().withMessage('Category is required'),
  body('amount').isFloat({ min: 0 }).withMessage('Amount must be positive'),
  body('description').notEmpty().withMessage('Description is required'),
  body('expenseDate').isISO8601().withMessage('Invalid date format')
];

// ================================
// HELPER FUNCTIONS
// ================================

async function calculateOrderCosts(locationId, fuelRequired, fuelPricePerLiter, totalOrderAmount) {
  // Get haulage rate for location
  const haulageRate = await prisma.haulageRate.findFirst({
    where: { 
      locationId,
      isActive: true
    },
    orderBy: { effectiveDate: 'desc' }
  });

  // Get salary rates for location
  const salaryRate = await prisma.salaryRate.findFirst({
    where: {
      locationId,
      isActive: true
    },
    orderBy: { effectiveDate: 'desc' }
  });

  const baseHaulageRate = haulageRate ? parseFloat(haulageRate.rate) : 50000;
  const driverWages = salaryRate ? parseFloat(salaryRate.driverRate) : 5000;
  const tripAllowance = salaryRate ? parseFloat(salaryRate.tripAllowance) : 2000;
  const motorBoyWages = salaryRate ? parseFloat(salaryRate.motorBoyRate) : 3000;

  // Calculate costs
  const totalFuelCost = fuelRequired * fuelPricePerLiter;
  const serviceChargePercent = 10;
  const serviceChargeExpense = (serviceChargePercent / 100) * baseHaulageRate;
  const truckExpenses = 0; // Initial, can be updated later

  const totalTripExpenses = totalFuelCost + driverWages + tripAllowance + motorBoyWages + serviceChargeExpense + truckExpenses;
  
  const revenue = totalOrderAmount;
  const grossProfit = revenue - totalFuelCost - driverWages - tripAllowance - motorBoyWages;
  const netProfit = revenue - totalTripExpenses;
  const profitMargin = revenue > 0 ? parseFloat(((netProfit / revenue) * 100).toFixed(2)) : 0;

  return {
    baseHaulageRate,
    fuelRequired,
    fuelPricePerLiter,
    totalFuelCost,
    driverWages,
    tripAllowance,
    motorBoyWages,
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
// @desc    Create transport order with auto-calculated costs
// @access  Private (Transport module access)
router.post('/orders',
  createTransportOrderValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      orderNumber,
      clientName,
      clientPhone,
      pickupLocation,
      deliveryAddress,
      locationId,
      totalOrderAmount,
      fuelRequired,
      fuelPricePerLiter,
      truckId,
      driverDetails,
      invoiceNumber
    } = req.body;

    const userId = req.user.id;

    // Calculate all costs
    const calculatedCosts = await calculateOrderCosts(
      locationId,
      fuelRequired,
      fuelPricePerLiter,
      totalOrderAmount
    );

    // Create order in transaction
    const order = await prisma.$transaction(async (tx) => {
      const transportOrder = await tx.transportOrder.create({
        data: {
          orderNumber,
          clientName,
          clientPhone,
          pickupLocation,
          deliveryAddress,
          locationId,
          totalOrderAmount: calculatedCosts.totalOrderAmount,
          
          // Fuel details
          fuelRequired: calculatedCosts.fuelRequired,
          fuelPricePerLiter: calculatedCosts.fuelPricePerLiter,
          totalFuelCost: calculatedCosts.totalFuelCost,
          
          // Wages
          tripAllowance: calculatedCosts.tripAllowance,
          driverWages: calculatedCosts.driverWages,
          motorBoyWages: calculatedCosts.motorBoyWages,
          
          // Service charge
          serviceChargePercent: calculatedCosts.serviceChargePercent,
          serviceChargeExpense: calculatedCosts.serviceChargeExpense,
          
          // Expenses & Profit
          truckExpenses: calculatedCosts.truckExpenses,
          totalTripExpenses: calculatedCosts.totalTripExpenses,
          grossProfit: calculatedCosts.grossProfit,
          netProfit: calculatedCosts.netProfit,
          profitMargin: calculatedCosts.profitMargin,
          
          truckId,
          driverDetails,
          invoiceNumber,
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

      // Create analytics entry
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

      // Audit log
      await tx.auditLog.create({
        data: {
          userId,
          action: 'CREATE',
          entity: 'TransportOrder',
          entityId: transportOrder.id,
          newValues: {
            orderNumber: transportOrder.orderNumber,
            clientName: transportOrder.clientName,
            totalAmount: transportOrder.totalOrderAmount,
            netProfit: transportOrder.netProfit
          }
        }
      });

      return transportOrder;
    });

    res.status(201).json({
      success: true,
      message: 'Transport order created successfully',
      data: {
        transportOrder: order,
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
  asyncHandler(async (req, res) => {
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

    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { clientName: { contains: search, mode: 'insensitive' } },
        { invoiceNumber: { contains: search, mode: 'insensitive' } }
      ];
    }

    // Role-based filtering
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.createdBy = req.user.id;
    }

    const [orders, total] = await Promise.all([
      prisma.transportOrder.findMany({
        where,
        include: {
          location: { select: { id: true, name: true } },
          truck: { select: { truckId: true, registrationNumber: true } },
          createdByUser: { select: { username: true } }
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
          pages: Math.ceil(total / parseInt(limit))
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
        motorBoyWages: calculatedCosts.motorBoyWages,
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
// @desc    Update order delivery status
// @access  Private (Transport module access)
router.put('/orders/:id/status',
  param('id').custom(validateCuid('order ID')),
  body('deliveryStatus').isIn(['PENDING', 'CONFIRMED', 'PROCESSING', 'IN_TRANSIT', 'DELIVERED', 'PARTIALLY_DELIVERED', 'CANCELLED']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { deliveryStatus } = req.body;

    const updatedOrder = await prisma.transportOrder.update({
      where: { id },
      data: { 
        deliveryStatus,
        deliveryDate: deliveryStatus === 'DELIVERED' ? new Date() : undefined
      },
      include: {
        location: true,
        truck: true
      }
    });

    res.json({
      success: true,
      message: `Order status updated to ${deliveryStatus}`,
      data: { order: updatedOrder }
    });
  })
);

// ================================
// LOCATIONS (NEW)
// ================================

// @route   GET /api/v1/transport/locations
// @desc    Get delivery locations
// @access  Private (Transport module access)
router.get('/locations',
  asyncHandler(async (req, res) => {
    const locations = await prisma.location.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        address: true,
        isActive: true
      }
    });

    res.json({
      success: true,
      data: { locations }
    });
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
      expenseDate
    } = req.body;

    const userId = req.user.id;

    const expense = await prisma.transportExpense.create({
      data: {
        truckId,
        locationId,
        expenseType,
        category,
        amount,
        description,
        expenseDate: new Date(expenseDate),
        status: 'PENDING',
        createdBy: userId
      },
      include: {
        truck: { select: { truckId: true, registrationNumber: true } },
        location: { select: { name: true } },
        createdByUser: { select: { username: true } }
      }
    });

    // Audit log
    await logDataChange(
      userId,
      'transportExpense',
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
        createdByUser: { select: { username: true } }
      },
      orderBy: { expenseDate: 'desc' }
    });

    const fields = [
      'expenseType',
      'category',
      'amount',
      'description',
      'expenseDate',
      'status',
      'truck.registrationNumber',
      'createdByUser.username'
    ];

    const json2csvParser = new Parser({ fields });
    const csv = json2csvParser.parse(expenses);

    res.header('Content-Type', 'text/csv');
    res.attachment(`transport-expenses-${Date.now()}.csv`);
    res.send(csv);
  })
);

module.exports = router;enseDate = {};
      if (startDate) where.expenseDate.gte = new Date(startDate);
      if (endDate) where.expenseDate.lte = new Date(endDate);
    }

    // Non-admin users can only see their own expenses
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.createdBy = req.user.id;
    }

    const [expenses, total] = await Promise.all([
      prisma.transportExpense.findMany({
        where,
        include: {
          truck: { select: { truckId: true, registrationNumber: true } },
          location: { select: { name: true } },
          createdByUser: { select: { username: true } },
          approvedByUser: { select: { username: true } }
        },
        orderBy: { expenseDate: 'desc' },
        skip,
        take
      }),
      prisma.transportExpense.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        expenses,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
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

    const expense = await prisma.transportExpense.findUnique({
      where: { id },
      include: {
        truck: true,
        location: true,
        createdByUser: { select: { username: true, role: true } },
        approvedByUser: { select: { username: true, role: true } }
      }
    });

    if (!expense) {
      throw new NotFoundError('Expense not found');
    }

    res.json({
      success: true,
      data: { expense }
    });
  })
);

// @route   PUT /api/v1/transport/expenses/:id
// @desc    Update expense
// @access  Private (Creator or Admin)
router.put('/expenses/:id',
  param('id').custom(validateCuid('expense ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const updateData = req.body;
    const userId = req.user.id;

    const existingExpense = await prisma.transportExpense.findUnique({
      where: { id }
    });

    if (!existingExpense) {
      throw new NotFoundError('Expense not found');
    }

    // Only creator or admin can update
    if (existingExpense.createdBy !== userId && !req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      throw new BusinessError('Permission denied', 'PERMISSION_DENIED');
    }

    // Cannot update approved/rejected expenses
    if (existingExpense.status !== 'PENDING') {
      throw new BusinessError('Cannot update expense that has been approved or rejected', 'INVALID_STATUS');
    }

    const updatedExpense = await prisma.transportExpense.update({
      where: { id },
      data: updateData,
      include: {
        truck: true,
        location: true
      }
    });

    res.json({
      success: true,
      message: 'Expense updated successfully',
      data: { expense: updatedExpense }
    });
  })
);

// @route   PUT /api/v1/transport/expenses/:id/approve
// @desc    Approve expense
// @access  Private (Admin only)
router.put('/expenses/:id/approve',
  param('id').custom(validateCuid('expense ID')),
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  body('notes').optional().trim(),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { notes } = req.body;
    const userId = req.user.id;

    const expense = await prisma.transportExpense.findUnique({
      where: { id }
    });

    if (!expense) {
      throw new NotFoundError('Expense not found');
    }

    if (expense.status !== 'PENDING') {
      throw new BusinessError('Expense has already been processed', 'INVALID_STATUS');
    }

    const updatedExpense = await prisma.transportExpense.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedBy: userId,
        approvedAt: new Date(),
        approvalNotes: notes
      },
      include: {
        truck: true,
        createdByUser: { select: { username: true } }
      }
    });

    res.json({
      success: true,
      message: 'Expense approved successfully',
      data: { expense: updatedExpense }
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

    const expense = await prisma.transportExpense.findUnique({
      where: { id }
    });

    if (!expense) {
      throw new NotFoundError('Expense not found');
    }

    if (expense.status !== 'PENDING') {
      throw new BusinessError('Expense has already been processed', 'INVALID_STATUS');
    }

    const updatedExpense = await prisma.transportExpense.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectedBy: userId,
        rejectedAt: new Date(),
        approvalNotes: reason
      },
      include: {
        truck: true,
        createdByUser: { select: { username: true } }
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
// @desc    Bulk approve expenses
// @access  Private (Admin only)
router.post('/expenses/bulk-approve',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  body('expenseIds').isArray({ min: 1 }).withMessage('Must provide at least one expense ID'),
  body('expenseIds.*').custom(validateCuid('expense ID')),
  body('notes').optional().trim(),
  asyncHandler(async (req, res) => {
    const { expenseIds, notes } = req.body;
    const userId = req.user.id;

    const updatedExpenses = await prisma.transportExpense.updateMany({
      where: {
        id: { in: expenseIds },
        status: 'PENDING'
      },
      data: {
        status: 'APPROVED',
        approvedBy: userId,
        approvedAt: new Date(),
        approvalNotes: notes
      }
    });

    res.json({
      success: true,
      message: `${updatedExpenses.count} expenses approved successfully`,
      data: { count: updatedExpenses.count }
    });
  })
);

// ================================
// EXPORT FUNCTIONS
// ================================

// @route   GET /api/v1/transport/orders/export/csv
// @desc    Export orders to CSV
// @access  Private (Transport module access)
router.get('/orders/export/csv',
  asyncHandler(async (req, res) => {
    const { startDate, endDate, status } = req.query;

    const where = {};
    if (status) where.deliveryStatus = status;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const orders = await prisma.transportOrder.findMany({
      where,
      include: {
        location: { select: { name: true } },
        truck: { select: { registrationNumber: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const fields = [
      'orderNumber',
      'clientName',
      'location.name',
      'totalOrderAmount',
      'netProfit',
      'profitMargin',
      'deliveryStatus',
      'createdAt'
    ];

    const json2csvParser = new Parser({ fields });
    const csv = json2csvParser.parse(orders);

    res.header('Content-Type', 'text/csv');
    res.attachment(`transport-orders-${Date.now()}.csv`);
    res.send(csv);
  })
);

// @route   GET /api/v1/transport/expenses/export/csv
// @desc    Export expenses to CSV
// @access  Private (Admin)
router.get('/expenses/export/csv',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  asyncHandler(async (req, res) => {
    const { startDate, endDate, status } = req.query;

    const where = {};
    if (status) where.status = status;
    if (startDate || endDate) {
      where.expenseDate = {};