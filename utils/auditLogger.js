// utils/auditLogger.js
// Centralized audit logging utility

const prisma = require('../lib/prisma');

/**
 * Create an audit log entry
 * @param {Object} params - Audit log parameters
 * @param {string} params.userId - User ID performing the action
 * @param {string} params.action - Action performed (CREATE, UPDATE, DELETE, etc.)
 * @param {string} params.entity - Entity type (WarehouseInventory, WarehouseSale, etc.)
 * @param {string} params.entityId - ID of the affected entity
 * @param {Object} params.oldValues - Previous values (for UPDATE/DELETE)
 * @param {Object} params.newValues - New values (for CREATE/UPDATE)
 * @param {string} params.ipAddress - IP address of the user
 * @param {string} params.userAgent - User agent string
 * @param {Object} params.metadata - Additional metadata
 * @param {Object} tx - Optional Prisma transaction client
 */
async function createAuditLog({
  userId,
  action,
  entity,
  entityId,
  oldValues = null,
  newValues = null,
  ipAddress = null,
  userAgent = null,
  metadata = null
}, tx = null) {
  const client = tx || prisma;

  try {
    // Prepare audit data with metadata
    const auditData = {
      userId,
      action,
      entity,
      entityId,
      oldValues: oldValues ? JSON.parse(JSON.stringify(oldValues)) : null,
      newValues: newValues ? JSON.parse(JSON.stringify(newValues)) : null,
      ipAddress,
      userAgent
    };

    // Add metadata to newValues if provided
    if (metadata && auditData.newValues) {
      auditData.newValues.metadata = metadata;
    } else if (metadata && !auditData.newValues) {
      auditData.newValues = { metadata };
    }

    const auditLog = await client.auditLog.create({
      data: auditData
    });

    console.log(`📝 Audit Log Created: ${action} ${entity} by User ${userId}`);
    return auditLog;

  } catch (error) {
    // Don't fail the main operation if audit logging fails
    console.error('❌ Failed to create audit log:', error.message);
    // Still throw in development to catch issues
    if (process.env.NODE_ENV === 'development') {
      console.error('Audit log details:', {
        userId, action, entity, entityId
      });
    }
    return null;
  }
}

/**
 * Create audit log for inventory changes
 * Specifically tracks stock quantity changes
 */
async function logInventoryChange({
  userId,
  action,
  inventoryId,
  productId,
  productName,
  oldInventory,
  newInventory,
  reason = null,
  triggeredBy = null, // 'SALE', 'PURCHASE', 'MANUAL_ADJUSTMENT', 'PURCHASE_DELETE', etc.
  referenceId = null, // Sale ID, Purchase ID, etc.
  ipAddress = null,
  userAgent = null
}, tx = null) {

  const metadata = {
    productId,
    productName,
    reason,
    triggeredBy,
    referenceId,
    timestamp: new Date().toISOString()
  };

  // Calculate changes
  if (oldInventory && newInventory) {
    metadata.changes = {
      pallets: {
        old: oldInventory.pallets,
        new: newInventory.pallets,
        diff: newInventory.pallets - oldInventory.pallets
      },
      packs: {
        old: oldInventory.packs,
        new: newInventory.packs,
        diff: newInventory.packs - oldInventory.packs
      },
      units: {
        old: oldInventory.units,
        new: newInventory.units,
        diff: newInventory.units - oldInventory.units
      }
    };
  }

  return createAuditLog({
    userId,
    action,
    entity: 'WarehouseInventory',
    entityId: inventoryId,
    oldValues: oldInventory,
    newValues: newInventory,
    ipAddress,
    userAgent,
    metadata
  }, tx);
}

/**
 * Create audit log for purchase operations
 */
async function logPurchaseChange({
  userId,
  action,
  purchaseId,
  oldPurchase,
  newPurchase,
  reason = null,
  ipAddress = null,
  userAgent = null
}, tx = null) {

  const metadata = {
    reason,
    timestamp: new Date().toISOString()
  };

  // Calculate quantity change if UPDATE
  if (action === 'UPDATE' && oldPurchase && newPurchase) {
    if (oldPurchase.quantity !== newPurchase.quantity) {
      metadata.quantityChange = {
        old: oldPurchase.quantity,
        new: newPurchase.quantity,
        diff: newPurchase.quantity - oldPurchase.quantity,
        unitType: newPurchase.unitType
      };
    }
  }

  return createAuditLog({
    userId,
    action,
    entity: 'WarehouseProductPurchase',
    entityId: purchaseId,
    oldValues: oldPurchase,
    newValues: newPurchase,
    ipAddress,
    userAgent,
    metadata
  }, tx);
}

/**
 * Create audit log for sale operations
 */
async function logSaleChange({
  userId,
  action,
  saleId,
  oldSale,
  newSale,
  reason = null,
  ipAddress = null,
  userAgent = null
}, tx = null) {

  const metadata = {
    reason,
    timestamp: new Date().toISOString()
  };

  return createAuditLog({
    userId,
    action,
    entity: 'WarehouseSale',
    entityId: saleId,
    oldValues: oldSale,
    newValues: newSale,
    ipAddress,
    userAgent,
    metadata
  }, tx);
}

/**
 * Create audit log for batch status changes
 */
async function logBatchStatusChange({
  userId = 'SYSTEM',
  action,
  batchId,
  oldStatus,
  newStatus,
  reason = null,
  quantityRemaining = null,
  expiryDate = null,
  ipAddress = null,
  userAgent = null
}, tx = null) {

  const metadata = {
    statusChange: {
      old: oldStatus,
      new: newStatus
    },
    reason,
    quantityRemaining,
    expiryDate,
    timestamp: new Date().toISOString()
  };

  return createAuditLog({
    userId,
    action: 'UPDATE_BATCH_STATUS',
    entity: 'WarehouseProductPurchase',
    entityId: batchId,
    oldValues: { batchStatus: oldStatus },
    newValues: { batchStatus: newStatus },
    ipAddress,
    userAgent,
    metadata
  }, tx);
}

/**
 * Helper to extract IP and User Agent from request
 */
function getRequestMetadata(req) {
  return {
    ipAddress: req.ip || req.connection?.remoteAddress || null,
    userAgent: req.get('user-agent') || null
  };
}

module.exports = {
  createAuditLog,
  logInventoryChange,
  logPurchaseChange,
  logSaleChange,
  logBatchStatusChange,
  getRequestMetadata
};
