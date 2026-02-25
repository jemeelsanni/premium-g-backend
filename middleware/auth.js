const jwt = require('jsonwebtoken');

const prisma = require('../lib/prisma');

// ================================
// USER ROLES AND PERMISSIONS
// ================================

const USER_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  DISTRIBUTION_ADMIN: 'DISTRIBUTION_ADMIN',
  TRANSPORT_ADMIN: 'TRANSPORT_ADMIN',
  WAREHOUSE_ADMIN: 'WAREHOUSE_ADMIN',
  DISTRIBUTION_SALES_REP: 'DISTRIBUTION_SALES_REP',
  WAREHOUSE_SALES_OFFICER: 'WAREHOUSE_SALES_OFFICER',
  CASHIER: 'CASHIER',
  TRANSPORT_STAFF: 'TRANSPORT_STAFF'
};

const MODULE_PERMISSIONS = {
  [USER_ROLES.SUPER_ADMIN]: {
    distribution: ['read', 'write', 'admin'],
    transport: ['read', 'write', 'admin'],
    warehouse: ['read', 'write', 'admin'],
    admin: ['read', 'write', 'admin']
  },
  [USER_ROLES.DISTRIBUTION_ADMIN]: {
    distribution: ['read', 'write', 'admin'],
    transport: [], // NO ACCESS
    warehouse: [], // NO ACCESS
    admin: []
  },
  [USER_ROLES.TRANSPORT_ADMIN]: {
    distribution: [], // NO ACCESS
    transport: ['read', 'write', 'admin'],
    warehouse: [], // NO ACCESS
    admin: []
  },
  [USER_ROLES.WAREHOUSE_ADMIN]: {
    distribution: [], // NO ACCESS
    transport: [], // NO ACCESS
    warehouse: ['read', 'write', 'admin'],
    admin: []
  },
  [USER_ROLES.DISTRIBUTION_SALES_REP]: {
    distribution: ['read', 'write'],
    transport: [], // NO ACCESS
    warehouse: [], // NO ACCESS
    admin: []
  },
  [USER_ROLES.WAREHOUSE_SALES_OFFICER]: {
    distribution: [], // NO ACCESS
    transport: [], // NO ACCESS
    warehouse: ['read', 'write'],
    admin: []
  },
  [USER_ROLES.TRANSPORT_STAFF]: {
    distribution: [], // NO ACCESS
    transport: ['read', 'write'],
    warehouse: [], // NO ACCESS
    admin: []
  },
  [USER_ROLES.CASHIER]: {
    distribution: [], // NO ACCESS
    transport: [], // NO ACCESS
    warehouse: ['read'], // Only cash flow operations
    admin: []
  }
};

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
  if (user.role === USER_ROLES.SUPER_ADMIN) {
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
  const userPermissions = MODULE_PERMISSIONS[userRole] || {};
  const modulePermissions = userPermissions[module] || [];
  return modulePermissions.includes(permission);
};

const getUserModules = (userRole) => {
  const userPermissions = MODULE_PERMISSIONS[userRole] || {};
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
  USER_ROLES,
  MODULE_PERMISSIONS
};