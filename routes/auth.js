const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');

const { asyncHandler, ValidationError, BusinessError } = require('../middleware/errorHandler');
const { authenticateToken } = require('../middleware/auth');
const { logAuthEvent, getClientIP } = require('../middleware/auditLogger');

const router = express.Router();
const prisma = require('../lib/prisma');

// ================================
// VALIDATION RULES
// ================================

const loginValidation = [
  body('username')
    .notEmpty()
    .withMessage('Username is required')
    .isLength({ min: 3 })
    .withMessage('Username must be at least 3 characters'),
  body('password')
    .notEmpty()
    .withMessage('Password is required')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters')
];

const registerValidation = [
  body('username')
    .isLength({ min: 3, max: 50 })
    .withMessage('Username must be between 3-50 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  body('email')
    .isEmail()
    .withMessage('Valid email is required')
    .normalizeEmail(),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('Password must contain at least one uppercase letter, one lowercase letter, and one number'),
  body('role')
    .isIn(['SUPER_ADMIN', 'DISTRIBUTION_ADMIN', 'TRANSPORT_ADMIN', 'WAREHOUSE_ADMIN', 
           'DISTRIBUTION_SALES_REP', 'WAREHOUSE_SALES_OFFICER', 'CASHIER', 'TRANSPORT_STAFF'])
    .withMessage('Invalid role specified')
];

const changePasswordValidation = [
  body('currentPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('New password must be at least 8 characters')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage('New password must contain at least one uppercase letter, one lowercase letter, and one number')
];

// ================================
// UTILITY FUNCTIONS
// ================================

const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  return { accessToken };
};

const createUserSession = async (userId, token, req) => {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

  return await prisma.userSession.create({
    data: {
      userId,
      token,
      expiresAt,
      ipAddress: getClientIP(req),
      userAgent: req.get('User-Agent') || null
    }
  });
};

// ================================
// AUTH ROUTES
// ================================

// @route   POST /api/v1/auth/login
// @desc    Authenticate user and get token
// @access  Public
router.post('/login', loginValidation, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    throw new ValidationError('Invalid input data', errors.array());
  }

  const { username, password } = req.body;
  const ipAddress = getClientIP(req);
  const userAgent = req.get('User-Agent');

  try {
    // Find user by username or email
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username },
          { email: username }
        ]
      }
    });

    if (!user) {
      await logAuthEvent(null, 'LOGIN_FAILED', ipAddress, userAgent, false);
      throw new BusinessError('Invalid credentials', 'INVALID_CREDENTIALS');
    }

    if (!user.isActive) {
      await logAuthEvent(user.id, 'LOGIN_FAILED', ipAddress, userAgent, false);
      throw new BusinessError('Account is deactivated', 'ACCOUNT_DEACTIVATED');
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      await logAuthEvent(user.id, 'LOGIN_FAILED', ipAddress, userAgent, false);
      throw new BusinessError('Invalid credentials', 'INVALID_CREDENTIALS');
    }

    // Generate tokens
    const { accessToken } = generateTokens(user.id);

    // Create session
    await createUserSession(user.id, accessToken, req);

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() }
    });

    // Log successful login
    await logAuthEvent(user.id, 'LOGIN_SUCCESS', ipAddress, userAgent, true);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        accessToken,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role
        }
      }
    });

  } catch (error) {
    if (error instanceof BusinessError) {
      throw error;
    }

    console.error('Login error details:', error);
    await logAuthEvent(null, 'LOGIN_ERROR', ipAddress, userAgent, false);
    throw new BusinessError('Login failed: ' + error.message, 'LOGIN_ERROR');
  }
}));

// @route   POST /api/v1/auth/register
// @desc    Register new user (Admin only)
// @access  Private (Super Admin only)
router.post('/register', 
  authenticateToken,
  registerValidation, 
  asyncHandler(async (req, res) => {
    // Only Super Admin can register new users
    if (req.user.role !== 'SUPER_ADMIN') {
      throw new BusinessError('Only Super Admin can register new users', 'INSUFFICIENT_PERMISSIONS');
    }

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { username, email, password, role } = req.body;

    // Check if user already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username },
          { email }
        ]
      }
    });

    if (existingUser) {
      throw new BusinessError('User with this username or email already exists', 'USER_EXISTS');
    }

    // Hash password
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Create user
    const user = await prisma.user.create({
      data: {
        username,
        email,
        passwordHash,
        role
      },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
        createdAt: true
      }
    });

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: { user }
    });
  })
);

// @route   POST /api/v1/auth/logout
// @desc    Logout user and invalidate token
// @access  Private
router.post('/logout', authenticateToken, asyncHandler(async (req, res) => {
  const { sessionId } = req.user;

  // Invalidate session
  await prisma.userSession.update({
    where: { id: sessionId },
    data: { isActive: false }
  });

  // Log logout
  await logAuthEvent(
    req.user.id, 
    'LOGOUT', 
    getClientIP(req), 
    req.get('User-Agent'), 
    true
  );

  res.json({
    success: true,
    message: 'Logged out successfully'
  });
}));

// @route   POST /api/v1/auth/change-password
// @desc    Change user password
// @access  Private
router.post('/change-password', 
  authenticateToken,
  changePasswordValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { currentPassword, newPassword } = req.body;
    const { id: userId } = req.user;

    // Get current user
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new BusinessError('User not found', 'USER_NOT_FOUND');
    }

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!isCurrentPasswordValid) {
      throw new BusinessError('Current password is incorrect', 'INVALID_CURRENT_PASSWORD');
    }

    // Check if new password is different
    const isSamePassword = await bcrypt.compare(newPassword, user.passwordHash);
    if (isSamePassword) {
      throw new BusinessError('New password must be different from current password', 'SAME_PASSWORD');
    }

    // Hash new password
    const saltRounds = 12;
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

    // Update password
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash }
    });

    // Invalidate all sessions except current one
    await prisma.userSession.updateMany({
      where: {
        userId,
        id: { not: req.user.sessionId }
      },
      data: { isActive: false }
    });

    res.json({
      success: true,
      message: 'Password changed successfully'
    });
  })
);

// Add this to routes/auth.js (Backend)

// @route   GET /api/v1/auth/me
// @desc    Get current user info
// @access  Private
router.get('/me', authenticateToken, asyncHandler(async (req, res) => {
  // Return current user info (already attached by authenticateToken middleware)
  res.json({
    success: true,
    data: {
      id: req.user.id,
      username: req.user.username,
      email: req.user.email,
      role: req.user.role,
      permissions: req.user.permissions || {},
      isActive: true
    }
  });
}));

// @route   GET /api/v1/auth/profile  
// @desc    Get detailed user profile
// @access  Private
router.get('/profile', authenticateToken, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      username: true,
      email: true,
      role: true,
      isActive: true,
      permissions: true,
      createdAt: true,
      lastLoginAt: true
    }
  });

  if (!user) {
    throw new BusinessError('User not found', 'USER_NOT_FOUND');
  }

  res.json({
    success: true,
    data: {
      user
    }
  });
}));

// @route   GET /api/v1/auth/sessions
// @desc    Get user's active sessions
// @access  Private
router.get('/sessions', authenticateToken, asyncHandler(async (req, res) => {
  const sessions = await prisma.userSession.findMany({
    where: {
      userId: req.user.id,
      isActive: true,
      expiresAt: { gt: new Date() }
    },
    select: {
      id: true,
      ipAddress: true,
      userAgent: true,
      createdAt: true,
      expiresAt: true
    },
    orderBy: { createdAt: 'desc' }
  });

  // Mark current session
  const sessionsWithCurrent = sessions.map(session => ({
    ...session,
    isCurrent: session.id === req.user.sessionId
  }));

  res.json({
    success: true,
    data: { sessions: sessionsWithCurrent }
  });
}));

// @route   DELETE /api/v1/auth/sessions/:sessionId
// @desc    Terminate a specific session
// @access  Private
router.delete('/sessions/:sessionId', authenticateToken, asyncHandler(async (req, res) => {
  const { sessionId } = req.params;
  const { id: userId } = req.user;

  // Verify session belongs to user
  const session = await prisma.userSession.findFirst({
    where: {
      id: sessionId,
      userId
    }
  });

  if (!session) {
    throw new BusinessError('Session not found', 'SESSION_NOT_FOUND');
  }

  // Don't allow terminating current session
  if (sessionId === req.user.sessionId) {
    throw new BusinessError('Cannot terminate current session', 'CANNOT_TERMINATE_CURRENT_SESSION');
  }

  // Invalidate session
  await prisma.userSession.update({
    where: { id: sessionId },
    data: { isActive: false }
  });

  res.json({
    success: true,
    message: 'Session terminated successfully'
  });
}));

// @route   POST /api/v1/auth/verify-token
// @desc    Verify if token is valid
// @access  Private
router.post('/verify-token', authenticateToken, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    message: 'Token is valid',
    data: {
      user: {
        id: req.user.id,
        username: req.user.username,
        email: req.user.email,
        role: req.user.role
      }
    }
  });
}));

module.exports = router;