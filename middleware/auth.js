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

// Features that imply "write" access to a module
const WRITE_FEATURES = new Set([
  'create_order','edit_order','delete_order','record_payment','confirm_payment',
  'adjust_price','assign_transport','record_delivery','update_supplier_status',
  'manage_suppliers','manage_targets','create_expense','approve_expense',
  'manage_supplier_products','manage_profitability','edit_supplier',
  'manage_trucks','manage_locations','record_sales','edit_sales','delete_sales',
  'record_purchases','edit_purchases','delete_purchases','manage_inventory',
  'edit_debtors','request_discount','approve_discount','manage_expenses',
  'approve_expenses','submit_opening_stock','approve_opening_stock',
  'manage_users','reset_passwords','manage_products','manage_customers',
  'manage_config','manage_role_permissions',
]);

// Features that imply "admin" access to a module
const ADMIN_FEATURES = new Set([
  'delete_order','confirm_payment','adjust_price','approve_expense',
  'approve_discount','approve_expenses','approve_opening_stock',
  'manage_users','reset_passwords','manage_config','manage_role_permissions',
]);

// In-memory cache so DB is not hit on every single request
let _permissionsCache = null;
let _permissionsCacheTime = 0;
const PERMISSIONS_CACHE_TTL = 60 * 1000; // 1 minute

// Load feature-level permissions: DB first (persistent across Railway restarts), file as fallback
const getFeaturePermissions = () => {
  // Return cache if fresh
  if (_permissionsCache && Date.now() - _permissionsCacheTime < PERMISSIONS_CACHE_TTL) {
    return _permissionsCache;
  }
  // Synchronous file read as the immediate return (auth is sync)
  try {
    const raw = fs.readFileSync(PERMISSIONS_FILE, 'utf8');
    _permissionsCache = JSON.parse(raw);
    _permissionsCacheTime = Date.now();
  } catch {
    _permissionsCache = _permissionsCache || {};
  }
  // Async DB refresh in background — updates cache for next request
  prisma.systemConfig.findUnique({ where: { key: 'role_permissions' } })
    .then(row => {
      if (row?.value && typeof row.value === 'object') {
        _permissionsCache = row.value;
        _permissionsCacheTime = Date.now();
      }
    })
    .catch(() => {}); // silent — file fallback already used

  return _permissionsCache;
};

// Called by admin route after a successful save to immediately refresh cache
const invalidatePermissionsCache = (newPermissions) => {
  _permissionsCache = newPermissions;
  _permissionsCacheTime = Date.now();
};

// Derive module-level ['read','write','admin'] array from feature booleans
const deriveModuleLevels = (featureMap) => {
  const enabledFeatures = Object.entries(featureMap || {})
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);

  if (enabledFeatures.length === 0) return [];

  const levels = ['read'];
  if (enabledFeatures.some(f => WRITE_FEATURES.has(f))) levels.push('write');
  if (enabledFeatures.some(f => ADMIN_FEATURES.has(f))) levels.push('admin');
  return levels;
};

// Returns { distribution: ['read','write','admin'], transport: [], ... } per role
const getModulePermissions = () => {
  const features = getFeaturePermissions();
  const result = {};
  for (const role of Object.keys(features)) {
    result[role] = {};
    for (const mod of Object.keys(features[role])) {
      result[role][mod] = deriveModuleLevels(features[role][mod]);
    }
  }
  return result;
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

// Check a specific feature permission key (used for granular feature-level access)
const authorizeFeature = (module, feature) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required', message: 'User not authenticated' });
    }
    const perms = getFeaturePermissions();
    const granted = perms[req.user.role]?.[module]?.[feature] === true;
    if (!granted) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        message: `You don't have access to this feature`
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
  authorizeFeature,
  authorizeOwnEntry,
  hasPermission,
  getUserModules,
  canAccessModule,
  getModulePermissions,
  getFeaturePermissions,
  invalidatePermissionsCache,
  PERMISSIONS_FILE,
  USER_ROLES,
  MODULE_PERMISSIONS
};