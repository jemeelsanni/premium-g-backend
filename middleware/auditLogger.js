const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ================================
// AUDIT LOGGING MIDDLEWARE
// ================================

const auditLogger = async (req, res, next) => {
  // Skip audit logging for certain routes
  const skipRoutes = ['/health', '/api/v1/auth/login', '/api/v1/auth/refresh'];
  const shouldSkip = skipRoutes.some(route => req.path.includes(route));
  
  if (shouldSkip) {
    return next();
  }

  // Capture request details
  const originalSend = res.send;
  let responseBody = null;

  // Override res.send to capture response
  res.send = function(data) {
    responseBody = data;
    originalSend.call(this, data);
  };

  // Log after response is sent
  res.on('finish', async () => {
    try {
      // Only log if user is authenticated
      if (!req.user) return;

      // Determine action based on HTTP method
      let action = 'UNKNOWN';
      switch (req.method) {
        case 'GET':
          action = 'READ';
          break;
        case 'POST':
          action = 'CREATE';
          break;
        case 'PUT':
        case 'PATCH':
          action = 'UPDATE';
          break;
        case 'DELETE':
          action = 'DELETE';
          break;
      }

      // Determine entity from URL
      const pathParts = req.path.split('/').filter(Boolean);
      const entity = pathParts[pathParts.length - 2] || pathParts[pathParts.length - 1] || 'unknown';

      // Extract entity ID if present
      const entityId = req.params.id || req.body.id || null;

      // Prepare audit data
      const auditData = {
        userId: req.user.id,
        action,
        entity: entity.toUpperCase(),
        entityId,
        oldValues: req.method === 'PUT' || req.method === 'PATCH' ? req.body.oldValues : null,
        newValues: req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' ? 
                   sanitizeData(req.body) : null,
        ipAddress: getClientIP(req),
        userAgent: req.get('User-Agent') || null
      };

      // Only log successful operations (2xx status codes)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await prisma.auditLog.create({
          data: auditData
        });
      }

    } catch (error) {
      console.error('Audit logging error:', error);
      // Don't fail the request if audit logging fails
    }
  });

  next();
};

// ================================
// LOGIN/LOGOUT SPECIFIC LOGGING
// ================================

const logAuthEvent = async (userId, action, ipAddress, userAgent, success = true) => {
  try {
    await prisma.auditLog.create({
      data: {
        userId: userId || null,
        action,
        entity: 'AUTH',
        entityId: userId,
        newValues: { success },
        ipAddress,
        userAgent
      }
    });
  } catch (error) {
    console.error('Auth audit logging error:', error);
  }
};

// ================================
// DATA MODIFICATION LOGGING
// ================================

const logDataChange = async (userId, entity, entityId, action, oldValues = null, newValues = null, ipAddress = null) => {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        action,
        entity: entity.toUpperCase(),
        entityId,
        oldValues: oldValues ? sanitizeData(oldValues) : null,
        newValues: newValues ? sanitizeData(newValues) : null,
        ipAddress,
        userAgent: null // Not available in manual calls
      }
    });
  } catch (error) {
    console.error('Data change audit logging error:', error);
  }
};

// ================================
// UTILITY FUNCTIONS
// ================================

const sanitizeData = (data) => {
  if (!data || typeof data !== 'object') return data;
  
  const sanitized = { ...data };
  
  // Remove sensitive fields
  const sensitiveFields = ['password', 'passwordHash', 'token', 'secret'];
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  });

  return sanitized;
};

const getClientIP = (req) => {
  return req.headers['x-forwarded-for'] ||
         req.headers['x-real-ip'] ||
         req.connection.remoteAddress ||
         req.socket.remoteAddress ||
         (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
         '0.0.0.0';
};

// ================================
// AUDIT QUERY HELPERS
// ================================

const getAuditTrail = async (filters = {}) => {
  const {
    userId,
    entity,
    entityId,
    action,
    startDate,
    endDate,
    page = 1,
    limit = 50
  } = filters;

  const where = {};
  
  if (userId) where.userId = userId;
  if (entity) where.entity = entity.toUpperCase();
  if (entityId) where.entityId = entityId;
  if (action) where.action = action;
  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      include: {
        user: {
          select: {
            username: true,
            email: true,
            role: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      skip: (page - 1) * limit,
      take: limit
    })
  ]);

  return {
    logs,
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    }
  };
};

const getUserActivity = async (userId, days = 30) => {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  return await prisma.auditLog.findMany({
    where: {
      userId,
      createdAt: {
        gte: startDate
      }
    },
    orderBy: {
      createdAt: 'desc'
    },
    take: 100
  });
};

// ================================
// EXPORTS
// ================================

module.exports = {
  auditLogger,
  logAuthEvent,
  logDataChange,
  getAuditTrail,
  getUserActivity,
  sanitizeData,
  getClientIP
};