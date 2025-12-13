// routes/audit-logs.js
// Audit log viewing and reporting

const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const { authorizeRole } = require('../middleware/auth');
const { query, validationResult } = require('express-validator');

/**
 * @route   GET /api/v1/audit-logs
 * @desc    Get audit logs with filtering and pagination
 * @access  Private (Super Admin, Warehouse Admin)
 */
router.get('/',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [
    query('entity').optional().isString(),
    query('action').optional().isString(),
    query('entityId').optional().isString(),
    query('userId').optional().isString(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const {
      entity,
      action,
      entityId,
      userId,
      startDate,
      endDate,
      page = 1,
      limit = 50
    } = req.query;

    // Build where clause
    const where = {};
    if (entity) where.entity = entity;
    if (action) where.action = action;
    if (entityId) where.entityId = entityId;
    if (userId) where.userId = userId;

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    // Get total count
    const total = await prisma.auditLog.count({ where });

    // Get paginated logs
    const skip = (page - 1) * limit;
    const logs = await prisma.auditLog.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            role: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    });

    res.json({
      success: true,
      data: {
        logs,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  })
);

/**
 * @route   GET /api/v1/audit-logs/inventory-changes
 * @desc    Get inventory change audit logs with detailed info
 * @access  Private (Super Admin, Warehouse Admin)
 */
router.get('/inventory-changes',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [
    query('productId').optional().isString(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('triggeredBy').optional().isString(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const {
      productId,
      startDate,
      endDate,
      triggeredBy,
      page = 1,
      limit = 50
    } = req.query;

    // Build where clause
    const where = {
      entity: 'WarehouseInventory',
      action: 'UPDATE'
    };

    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    // Get all logs first (we'll filter by metadata after)
    const allLogs = await prisma.auditLog.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            role: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Filter by metadata fields
    let filteredLogs = allLogs;

    if (productId) {
      filteredLogs = filteredLogs.filter(log =>
        log.newValues?.metadata?.productId === productId
      );
    }

    if (triggeredBy) {
      filteredLogs = filteredLogs.filter(log =>
        log.newValues?.metadata?.triggeredBy === triggeredBy
      );
    }

    // Apply pagination
    const total = filteredLogs.length;
    const skip = (page - 1) * limit;
    const paginatedLogs = filteredLogs.slice(skip, skip + limit);

    // Transform logs to include extracted metadata
    const transformedLogs = paginatedLogs.map(log => ({
      id: log.id,
      userId: log.userId,
      user: log.user,
      action: log.action,
      entityId: log.entityId,
      createdAt: log.createdAt,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      productName: log.newValues?.metadata?.productName,
      productId: log.newValues?.metadata?.productId,
      triggeredBy: log.newValues?.metadata?.triggeredBy,
      referenceId: log.newValues?.metadata?.referenceId,
      reason: log.newValues?.metadata?.reason,
      changes: log.newValues?.metadata?.changes,
      oldInventory: log.oldValues,
      newInventory: {
        pallets: log.newValues?.pallets,
        packs: log.newValues?.packs,
        units: log.newValues?.units,
        reorderLevel: log.newValues?.reorderLevel
      }
    }));

    res.json({
      success: true,
      data: {
        logs: transformedLogs,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      }
    });
  })
);

/**
 * @route   GET /api/v1/audit-logs/suspicious-activities
 * @desc    Get suspicious inventory activities
 * @access  Private (Super Admin, Warehouse Admin)
 */
router.get('/suspicious-activities',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [
    query('days').optional().isInt({ min: 1, max: 90 }).toInt()
  ],
  asyncHandler(async (req, res) => {
    const { days = 7 } = req.query;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Get all inventory changes in the period
    const logs = await prisma.auditLog.findMany({
      where: {
        entity: 'WarehouseInventory',
        action: 'UPDATE',
        createdAt: { gte: startDate }
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            role: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Identify suspicious patterns
    const suspiciousLogs = [];

    for (const log of logs) {
      const metadata = log.newValues?.metadata;
      const changes = metadata?.changes;

      let suspicionReasons = [];

      // 1. Manual adjustments (not triggered by sale/purchase)
      if (metadata?.triggeredBy === 'MANUAL_ADJUSTMENT') {
        suspicionReasons.push('Direct manual inventory adjustment');
      }

      // 2. Large inventory reductions
      if (changes) {
        const packsReduction = changes.packs?.diff < -50;
        const palletsReduction = changes.pallets?.diff < -10;

        if (packsReduction || palletsReduction) {
          suspicionReasons.push(`Large reduction: ${changes.packs?.diff || 0} packs, ${changes.pallets?.diff || 0} pallets`);
        }
      }

      // 3. Purchase deletions
      if (metadata?.triggeredBy === 'PURCHASE_DELETE') {
        suspicionReasons.push('Purchase record deleted');
      }

      // 4. Sale deletions
      if (metadata?.triggeredBy === 'SALE_DELETE') {
        suspicionReasons.push('Sale record deleted');
      }

      // 5. No reason provided for manual adjustments
      if (metadata?.triggeredBy === 'MANUAL_ADJUSTMENT' &&
          (!metadata?.reason || metadata?.reason === 'No reason provided')) {
        suspicionReasons.push('No reason provided for manual adjustment');
      }

      if (suspicionReasons.length > 0) {
        suspiciousLogs.push({
          id: log.id,
          createdAt: log.createdAt,
          user: log.user,
          productName: metadata?.productName,
          productId: metadata?.productId,
          triggeredBy: metadata?.triggeredBy,
          reason: metadata?.reason,
          changes: changes,
          suspicionReasons,
          severity: suspicionReasons.length >= 2 ? 'HIGH' : 'MEDIUM'
        });
      }
    }

    // Sort by severity and date
    suspiciousLogs.sort((a, b) => {
      if (a.severity === 'HIGH' && b.severity !== 'HIGH') return -1;
      if (a.severity !== 'HIGH' && b.severity === 'HIGH') return 1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    res.json({
      success: true,
      data: {
        suspiciousActivities: suspiciousLogs,
        summary: {
          total: suspiciousLogs.length,
          high: suspiciousLogs.filter(l => l.severity === 'HIGH').length,
          medium: suspiciousLogs.filter(l => l.severity === 'MEDIUM').length,
          period: `Last ${days} days`
        }
      }
    });
  })
);

/**
 * @route   GET /api/v1/audit-logs/product/:productId
 * @desc    Get all audit logs for a specific product
 * @access  Private (Super Admin, Warehouse Admin)
 */
router.get('/product/:productId',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const { productId } = req.params;

    // Get product details
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { name: true, productNo: true }
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Get all audit logs related to this product
    const logs = await prisma.auditLog.findMany({
      where: {
        OR: [
          {
            entity: 'WarehouseInventory',
            newValues: {
              path: ['metadata', 'productId'],
              equals: productId
            }
          },
          {
            entity: 'WarehouseSale',
            oldValues: {
              path: ['productId'],
              equals: productId
            }
          },
          {
            entity: 'WarehouseProductPurchase',
            oldValues: {
              path: ['productId'],
              equals: productId
            }
          }
        ]
      },
      include: {
        user: {
          select: {
            username: true,
            role: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      data: {
        product,
        logs,
        summary: {
          totalChanges: logs.length,
          inventoryUpdates: logs.filter(l => l.entity === 'WarehouseInventory').length,
          salesChanges: logs.filter(l => l.entity === 'WarehouseSale').length,
          purchaseChanges: logs.filter(l => l.entity === 'WarehouseProductPurchase').length
        }
      }
    });
  })
);

module.exports = router;
