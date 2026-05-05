const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const bcrypt = require('bcrypt');

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeRole } = require('../middleware/auth');
const { getUserActivity } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators'); // ✅ ADDED

const router = express.Router();
const prisma = require('../lib/prisma');

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
    .isIn(['MANAGING_DIRECTOR', 'GENERAL_MANAGER', 'ACCOUNTANT', 'CASHIER', 'DISTRIBUTORSHIP_SALES_REP'])
    .withMessage('Invalid role specified')
];

// ================================
// ROUTES
// ================================

// @route   GET /api/v1/users
// @desc    Get all users with filtering and pagination
// @access  Private (Admin only)
router.get('/', 
  authorizeRole(['MANAGING_DIRECTOR', 'GENERAL_MANAGER', 'ACCOUNTANT']),
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
    const canAccess = ['MANAGING_DIRECTOR', 'GENERAL_MANAGER', 'ACCOUNTANT'].includes(req.user.role) ||
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
  authorizeRole(['MANAGING_DIRECTOR']),
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
  authorizeRole(['MANAGING_DIRECTOR']),
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
    const canAccess = ['MANAGING_DIRECTOR', 'GENERAL_MANAGER', 'ACCOUNTANT'].includes(req.user.role) ||
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
  authorizeRole(['MANAGING_DIRECTOR', 'GENERAL_MANAGER', 'ACCOUNTANT']),
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



// @route   POST /api/v1/users/:id/reset-password
// @desc    Reset a user's password (admin-initiated, no old password needed)
// @access  Private (Managing Director and General Manager only)
router.post('/:id/reset-password',
  param('id').custom(validateCuid('user ID')),
  authorizeRole(['MANAGING_DIRECTOR', 'GENERAL_MANAGER']),
  [
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/[A-Z]/)
      .withMessage('Password must contain at least one uppercase letter')
      .matches(/[a-z]/)
      .withMessage('Password must contain at least one lowercase letter')
      .matches(/[0-9]/)
      .withMessage('Password must contain at least one number')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { newPassword } = req.body;

    // Prevent changing own password through this endpoint
    if (req.user.id === id) {
      throw new BusinessError('Use the change-password endpoint to update your own password', 'USE_SELF_CHANGE_PASSWORD');
    }

    const user = await prisma.user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, 12);

    // Update password and invalidate all sessions
    await Promise.all([
      prisma.user.update({
        where: { id },
        data: { passwordHash }
      }),
      prisma.userSession.updateMany({
        where: { userId: id },
        data: { isActive: false }
      })
    ]);

    res.json({
      success: true,
      message: `Password for ${user.username} has been reset successfully`
    });
  })
);

module.exports = router;