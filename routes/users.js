const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeRole } = require('../middleware/auth');
const { getUserActivity } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators'); // ✅ ADDED

const router = express.Router();
const prisma = new PrismaClient();

// ================================
// VALIDATION RULES - UPDATED FOR CUID
// ================================

const updateUserValidation = [
  body('email')
    .optional()
    .isEmail()
    .withMessage('Valid email is required')
    .normalizeEmail(),
  body('isActive')
    .optional()
    .isBoolean()
    .withMessage('isActive must be a boolean'),
  body('role')
    .optional()
    .isIn(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN', 
           'DISTRIBUTION_SALES_REP', 'WAREHOUSE_SALES_OFFICER', 'CASHIER', 'TRANSPORT_STAFF'])
    .withMessage('Invalid role specified')
];

// ================================
// ROUTES
// ================================

// @route   GET /api/v1/users
// @desc    Get all users with filtering and pagination
// @access  Private (Admin only)
router.get('/', 
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const {
      page = 1,
      limit = 20,
      role,
      isActive,
      search
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const take = parseInt(limit);

    // Build where clause
    const where = {};

    if (role) where.role = role;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    if (search) {
      where.OR = [
        { username: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } }
      ];
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          username: true,
          email: true,
          role: true,
          isActive: true,
          createdAt: true,
          lastLoginAt: true
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take
      }),
      prisma.user.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        users,
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

// @route   GET /api/v1/users/:id
// @desc    Get single user
// @access  Private (Admin or own profile)
router.get('/:id',
  param('id').custom(validateCuid('user ID')), // ✅ UPDATED
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;

    // Check if user can access this profile
    const canAccess = req.user.role.includes('ADMIN') || 
                     req.user.role === 'SUPER_ADMIN' || 
                     req.user.id === id;

    if (!canAccess) {
      throw new BusinessError('Access denied', 'ACCESS_DENIED');
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true
      }
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    res.json({
      success: true,
      data: { user }
    });
  })
);

// @route   PUT /api/v1/users/:id
// @desc    Update user
// @access  Private (Super Admin only)
router.put('/:id',
  param('id').custom(validateCuid('user ID')), // ✅ UPDATED
  authorizeRole(['SUPER_ADMIN']),
  updateUserValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;

    // Prevent self-deactivation
    if (req.user.id === id && updateData.isActive === false) {
      throw new BusinessError('Cannot deactivate your own account', 'CANNOT_DEACTIVATE_SELF');
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { id }
    });

    if (!existingUser) {
      throw new NotFoundError('User not found');
    }

    // Update user
    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        lastLoginAt: true
      }
    });

    res.json({
      success: true,
      message: 'User updated successfully',
      data: { user: updatedUser }
    });
  })
);

// @route   DELETE /api/v1/users/:id
// @desc    Deactivate user (soft delete)
// @access  Private (Super Admin only)
router.delete('/:id',
  param('id').custom(validateCuid('user ID')), // ✅ UPDATED
  authorizeRole(['SUPER_ADMIN']),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;

    // Prevent self-deletion
    if (req.user.id === id) {
      throw new BusinessError('Cannot deactivate your own account', 'CANNOT_DEACTIVATE_SELF');
    }

    const user = await prisma.user.findUnique({
      where: { id }
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Soft delete by deactivating
    await prisma.user.update({
      where: { id },
      data: { isActive: false }
    });

    // Invalidate all user sessions
    await prisma.userSession.updateMany({
      where: { userId: id },
      data: { isActive: false }
    });

    res.json({
      success: true,
      message: 'User deactivated successfully'
    });
  })
);

// routes/users.js

// @route   GET /api/v1/users/:id/activity
// @desc    Get user activity log with analytics
// @access  Private (Admin or own profile)
router.get('/:id/activity',
  param('id').custom(validateCuid('user ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { days = 30 } = req.query;

    // Check if user can access this activity
    const canAccess = req.user.role.includes('ADMIN') || 
                     req.user.role === 'SUPER_ADMIN' || 
                     req.user.id === id;

    if (!canAccess) {
      throw new BusinessError('Access denied', 'ACCESS_DENIED');
    }

    // Get raw activity logs
    const activityLogs = await getUserActivity(id, parseInt(days));

    // Process into analytics
    const actionsByType = activityLogs.reduce((acc, log) => {
      const action = log.action || 'UNKNOWN';
      acc[action] = (acc[action] || 0) + 1;
      return acc;
    }, {});

    const analytics = {
      totalActions: activityLogs.length,
      recentActions: activityLogs.slice(0, 20).map(log => ({
        id: log.id,
        action: log.action,
        entity: log.entity,
        entityId: log.entityId,
        createdAt: log.createdAt,
        ipAddress: log.ipAddress
      })),
      actionsByType
    };

    res.json({
      success: true,
      data: { activity: analytics }
    });
  })
);

// @route   GET /api/v1/users/stats
// @desc    Get user statistics
// @access  Private (Admin only)
router.get('/stats/summary',
  authorizeRole(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const [
      totalUsers,
      activeUsers,
      usersByRole,
      recentLogins
    ] = await Promise.all([
      prisma.user.count(),
      
      prisma.user.count({
        where: { isActive: true }
      }),

      prisma.user.groupBy({
        by: ['role'],
        _count: { role: true }
      }),

      prisma.user.findMany({
        where: {
          lastLoginAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
          }
        },
        select: {
          id: true,
          username: true,
          role: true,
          lastLoginAt: true
        },
        orderBy: { lastLoginAt: 'desc' },
        take: 10
      })
    ]);

    res.json({
      success: true,
      data: {
        totalUsers,
        activeUsers,
        inactiveUsers: totalUsers - activeUsers,
        usersByRole,
        recentLogins
      }
    });
  })
);



module.exports = router;