const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorizeRole, authorizeModule } = require('../middleware/auth');
const { ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { validateCuid } = require('../utils/validators');
const { logDataChange } = require('../middleware/auditLogger');
const { getClientIP } = require('../utils/helpers');

const prisma = require('../lib/prisma');

// ================================
// VALIDATION RULES
// ================================

const createTruckValidation = [
  body('truckId')
    .trim()
    .notEmpty().withMessage('Truck ID is required')
    .isLength({ min: 3, max: 50 }).withMessage('Truck ID must be between 3 and 50 characters'),
  body('registrationNumber')
    .trim()
    .notEmpty().withMessage('Registration number is required')
    .isLength({ min: 3, max: 50 }).withMessage('Registration number must be between 3 and 50 characters'),
  body('maxPallets')
    .isInt({ min: 1 }).withMessage('Max pallets must be at least 1'),
  body('make')
    .optional()
    .trim()
    .isLength({ max: 50 }).withMessage('Make must not exceed 50 characters'),
  body('model')
    .optional()
    .trim()
    .isLength({ max: 50 }).withMessage('Model must not exceed 50 characters'),
  body('year')
    .optional()
    .isInt({ min: 1900, max: 2100 }).withMessage('Year must be a valid year'),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Notes must not exceed 500 characters')
];

const updateTruckValidation = [
  body('registrationNumber')
    .optional()
    .trim()
    .isLength({ min: 3, max: 50 }).withMessage('Registration number must be between 3 and 50 characters'),
  body('maxPallets')
    .optional()
    .isInt({ min: 1 }).withMessage('Max pallets must be at least 1'),
  body('currentLoad')
    .optional()
    .isInt({ min: 0 }).withMessage('Current load must be 0 or greater'),
  body('isActive')
    .optional()
    .isBoolean().withMessage('isActive must be a boolean'),
  body('make')
    .optional()
    .trim()
    .isLength({ max: 50 }).withMessage('Make must not exceed 50 characters'),
  body('model')
    .optional()
    .trim()
    .isLength({ max: 50 }).withMessage('Model must not exceed 50 characters'),
  body('year')
    .optional()
    .isInt({ min: 1900, max: 2100 }).withMessage('Year must be a valid year'),
  body('notes')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Notes must not exceed 500 characters')
];

// ================================
// TRUCK ROUTES
// ================================

// @route   POST /api/v1/transport/trucks
// @desc    Create new truck
// @access  Private (Transport Admin, Super Admin)
router.post('/trucks',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  createTruckValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { truckId, registrationNumber, maxPallets, make, model, year, notes } = req.body;
    const userId = req.user.id;

    // Check for duplicate truck ID
    const existingTruck = await prisma.truckCapacity.findUnique({
      where: { truckId }
    });

    if (existingTruck) {
      throw new BusinessError('Truck ID already exists', 'TRUCK_ID_EXISTS');
    }

    // Create truck
    const truck = await prisma.truckCapacity.create({
      data: {
        truckId,
        registrationNumber,
        maxPallets: parseInt(maxPallets),
        currentLoad: 0,
        availableSpace: parseInt(maxPallets),
        isActive: true,
        make,
        model,
        year: year ? parseInt(year) : null,
        notes
      }
    });

    // Log creation
    await logDataChange(
      userId,
      'truck_capacity',
      truck.id,
      'CREATE',
      null,
      truck,
      getClientIP(req)
    );

    res.status(201).json({
      success: true,
      message: 'Truck created successfully',
      data: { truck }
    });
  })
);

// @route   GET /api/v1/transport/trucks
// @desc    Get all trucks
// @access  Private (Transport module access)
router.get('/trucks',
  authorizeModule('transport', 'read'),
  asyncHandler(async (req, res) => {
    const trucks = await prisma.truckCapacity.findMany({
      orderBy: { truckId: 'asc' }
    });

    res.json({
      success: true,
      data: { trucks }
    });
  })
);

// @route   GET /api/v1/transport/trucks/:id
// @desc    Get single truck
// @access  Private (Transport module access)
router.get('/trucks/:id',
  authorizeModule('transport', 'read'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const truck = await prisma.truckCapacity.findUnique({
      where: { truckId: id }
    });

    if (!truck) {
      throw new NotFoundError('Truck not found');
    }

    res.json({
      success: true,
      data: { truck }
    });
  })
);

// @route   PUT /api/v1/transport/trucks/:id
// @desc    Update truck
// @access  Private (Transport Admin, Super Admin)
router.put('/trucks/:id',
  authorizeRole(['SUPER_ADMIN', 'TRANSPORT_ADMIN']),
  updateTruckValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;
    const userId = req.user.id;

    // Get existing truck
    const existingTruck = await prisma.truckCapacity.findUnique({
      where: { truckId: id }
    });

    if (!existingTruck) {
      throw new NotFoundError('Truck not found');
    }

    // If maxPallets is being updated, recalculate availableSpace
    if (updateData.maxPallets !== undefined) {
      const currentLoad = updateData.currentLoad !== undefined ? updateData.currentLoad : existingTruck.currentLoad;
      updateData.availableSpace = parseInt(updateData.maxPallets) - currentLoad;
    }

    // If currentLoad is being updated, recalculate availableSpace
    if (updateData.currentLoad !== undefined && updateData.maxPallets === undefined) {
      updateData.availableSpace = existingTruck.maxPallets - parseInt(updateData.currentLoad);
    }

    // Update truck
    const truck = await prisma.truckCapacity.update({
      where: { truckId: id },
      data: updateData
    });

    // Log update
    await logDataChange(
      userId,
      'truck_capacity',
      truck.id,
      'UPDATE',
      existingTruck,
      truck,
      getClientIP(req)
    );

    res.json({
      success: true,
      message: 'Truck updated successfully',
      data: { truck }
    });
  })
);

// @route   DELETE /api/v1/transport/trucks/:id
// @desc    Delete truck
// @access  Private (Super Admin only)
router.delete('/trucks/:id',
  authorizeRole(['SUPER_ADMIN']),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    const truck = await prisma.truckCapacity.findUnique({
      where: { truckId: id }
    });

    if (!truck) {
      throw new NotFoundError('Truck not found');
    }

    // Check if truck is being used in any transport orders
    const ordersUsingTruck = await prisma.transportOrder.count({
      where: { truckId: id }
    });

    if (ordersUsingTruck > 0) {
      throw new BusinessError(
        `Cannot delete truck. It is being used in ${ordersUsingTruck} transport order(s)`,
        'TRUCK_IN_USE'
      );
    }

    // Delete truck
    await prisma.truckCapacity.delete({
      where: { truckId: id }
    });

    // Log deletion
    await logDataChange(
      userId,
      'truck_capacity',
      truck.id,
      'DELETE',
      truck,
      null,
      getClientIP(req)
    );

    res.json({
      success: true,
      message: 'Truck deleted successfully'
    });
  })
);

module.exports = router;