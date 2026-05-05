const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

const prisma = require('../lib/prisma');

// ================================
// USER ROLES AND PERMISSIONS
// ================================

const USER_ROLES = {
  MANAGING_DIRECTOR: 'MANAGING_DIRECTOR',
  GENERAL_MANAGER: 'GENERAL_MANAGER',
  ACCOUNTANT: 'ACCOUNTANT',
  CASHIER: 'CASHIER',
  DISTRIBUTORSHIP_SALES_REP: 'DISTRIBUTORSHIP_SALES_REP',
};

const PERMISSIONS_FILE = path.join(__dirname, '../config/rolePermissions.json');

// Load permissions from file (fresh on every call so edits take effect immediately)
const getModulePermissions = () => {
  try {
    const raw = fs.readFileSync(PERMISSIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    // Fallback to safe defaults if file is missing or corrupt
    return {
      MANAGING_DIRECTOR: { distribution: ['read','write','admin'], transport: ['read','write','admin'], warehouse: ['read','write','admin'], admin: ['read','write','admin'] },
      GENERAL_MANAGER:   { distribution: ['read','write','admin'], transport: [],                      warehouse: ['read','write','admin'], admin: ['read','write','admin'] },
      ACCOUNTANT:        { distribution: ['read','write','admin'], transport: ['read','write','admin'], warehouse: ['read'],                admin: [] },
      CASHIER:           { distribution: [],                       transport: [],                      warehouse: ['read','write'],         admin: [] },
      DISTRIBUTORSHIP_SALES_REP: { distribution: ['read','write'], transport: [], warehouse: [], admin: [] },
    };
  }
};

// Keep MODULE_PERMISSIONS as a live getter for backward compatibility
const MODULE_PERMISSIONS = new Proxy({}, {
  get(_, role) {
    return getModulePermissions()[role];
  }
});

// ================================
// AUTHENTICATION MIDDLEWARE
// ================================

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({
        error: 'Access token required',
        message: 'Please provide a valid access token'
      });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Check if session exists and is active
    const session = await prisma.userSession.findUnique({
      where: { token },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            role: true,
            isActive: true,
            permissions: true
          }
        }
      }
    });

    if (!session || !session.isActive || new Date() > session.expiresAt) {
      return res.status(401).json({
        error: 'Invalid or expired token',
        message: 'Please login again'
      });
    }

    if (!session.user.isActive) {
      return res.status(401).json({
        error: 'Account deactivated',
        message: 'Your account has been deactivated. Contact administrator.'
      });
    }

    // Attach user info to request
    req.user = {
      id: session.user.id,
      username: session.user.username,
      email: session.user.email,
      role: session.user.role,
      permissions: session.user.permissions || {},
      sessionId: session.id
    };

    // Update last activity
    await prisma.userSession.update({
      where: { id: session.id },
      data: { 
        // Could add lastActivity field if needed
      }
    });

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Token is malformed'
      });
    }
    
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token expired',
        message: 'Please login again'
      });
    }

    return res.status(500).json({
      error: 'Authentication failed',
      message: 'Internal server error during authentication'
    });
  }
};

// ================================
// AUTHORIZATION MIDDLEWARE
// ================================

const authorizeRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'User not authenticated'
      });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        message: `Access denied. Required roles: ${allowedRoles.join(', ')}`
      });
    }

    next();
  };
};

const authorizeModule = (module, requiredPermission = 'read') => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'User not authenticated'
      });
    }

    const userPermissions = MODULE_PERMISSIONS[req.user.role] || {};
    const modulePermissions = userPermissions[module] || [];

    if (!modulePermissions.includes(requiredPermission)) {
      return res.status(403).json({
        error: 'Module access denied',
        message: `You don't have ${requiredPermission} access to ${module} module`
      });
    }

    next();
  };
};

// ================================
// DATA INTEGRITY PROTECTION
// ================================

// Users can only modify their own entries (except admins who have view-only)
const authorizeOwnEntry = (req, res, next) => {
  const { user } = req;
  const resourceUserId = req.params.userId || req.body.createdBy || req.body.userId;

  // Super admin can access anything
  if (user.role === USER_ROLES.MANAGING_DIRECTOR) {
    return next();
  }

  // Admins can only view, not modify
  const isAdmin = user.role.includes('_ADMIN');
  if (isAdmin && req.method !== 'GET') {
    return res.status(403).json({
      error: 'Admin view-only access',
      message: 'Admins can view but not modify user entries'
    });
  }

  // Regular users can only access their own entries
  if (resourceUserId && resourceUserId !== user.id) {
    return res.status(403).json({
      error: 'Access denied',
      message: 'You can only access your own entries'
    });
  }

  next();
};

// ================================
// UTILITY FUNCTIONS
// ================================

const hasPermission = (userRole, module, permission) => {
  const perms = getModulePermissions();
  const userPermissions = perms[userRole] || {};
  const modulePermissions = userPermissions[module] || [];
  return modulePermissions.includes(permission);
};

const getUserModules = (userRole) => {
  const perms = getModulePermissions();
  const userPermissions = perms[userRole] || {};
  return Object.keys(userPermissions).filter(module => userPermissions[module].length > 0);
};

const canAccessModule = (userRole, module) => {
  return hasPermission(userRole, module, 'read');
};

// ================================
// EXPORTS
// ================================

module.exports = {
  authenticateToken,
  authorizeRole,
  authorizeModule,
  authorizeOwnEntry,
  hasPermission,
  getUserModules,
  canAccessModule,
  getModulePermissions,
  PERMISSIONS_FILE,
  USER_ROLES,
  MODULE_PERMISSIONS
};