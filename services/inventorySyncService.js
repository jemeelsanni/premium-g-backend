/**
 * Inventory Synchronization Service
 *
 * This service ensures that the WarehouseInventory table is ALWAYS synchronized
 * with the batch system (WarehouseProductPurchase).
 *
 * The batch system is the SOURCE OF TRUTH.
 *
 * Features:
 * - Auto-sync after every sale creation/deletion
 * - Scheduled verification every 5 minutes
 * - Automatic correction of discrepancies
 * - Comprehensive audit logging
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Synchronize inventory for a specific product
 * @param {string} productId - The product ID to sync
 * @param {object} tx - Optional Prisma transaction object
 * @param {string} triggeredBy - What triggered this sync
 * @returns {object} Sync result with before/after values
 */
async function syncProductInventory(productId, tx = null, triggeredBy = 'manual') {
  const client = tx || prisma;

  try {
    // Get current inventory state BEFORE sync
    const inventoryBefore = await client.warehouseInventory.findFirst({
      where: { productId }
    });

    // Get all active/depleted batches (SOURCE OF TRUTH)
    const allBatches = await client.warehouseProductPurchase.findMany({
      where: {
        productId,
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
      }
    });

    // Calculate correct inventory from batches
    const calculatedInventory = {
      pallets: 0,
      packs: 0,
      units: 0
    };

    allBatches.forEach(batch => {
      const remaining = batch.quantityRemaining || 0;

      if (batch.unitType === 'PALLETS') {
        calculatedInventory.pallets += remaining;
      } else if (batch.unitType === 'PACKS') {
        calculatedInventory.packs += remaining;
      } else if (batch.unitType === 'UNITS') {
        calculatedInventory.units += remaining;
      }
    });

    // Check if there's a discrepancy
    const hadDiscrepancy = inventoryBefore && (
      inventoryBefore.pallets !== calculatedInventory.pallets ||
      inventoryBefore.packs !== calculatedInventory.packs ||
      inventoryBefore.units !== calculatedInventory.units
    );

    // Update inventory to match batch data
    await client.warehouseInventory.updateMany({
      where: { productId },
      data: {
        pallets: calculatedInventory.pallets,
        packs: calculatedInventory.packs,
        units: calculatedInventory.units,
        lastUpdated: new Date()
      }
    });

    // Log if there was a discrepancy that was corrected
    if (hadDiscrepancy) {
      const product = await client.product.findUnique({
        where: { id: productId },
        select: { name: true, productNo: true }
      });

      await client.auditLog.create({
        data: {
          entity: 'WarehouseInventory',
          entityId: inventoryBefore.id,
          action: 'AUTO_SYNC_CORRECTION',
          oldValues: {
            productName: product?.name,
            productNo: product?.productNo,
            triggeredBy,
            pallets: inventoryBefore.pallets,
            packs: inventoryBefore.packs,
            units: inventoryBefore.units
          },
          newValues: {
            productName: product?.name,
            productNo: product?.productNo,
            triggeredBy,
            pallets: calculatedInventory.pallets,
            packs: calculatedInventory.packs,
            units: calculatedInventory.units,
            discrepancy: {
              pallets: calculatedInventory.pallets - inventoryBefore.pallets,
              packs: calculatedInventory.packs - inventoryBefore.packs,
              units: calculatedInventory.units - inventoryBefore.units
            }
          }
        }
      });

      console.log(`⚠️  Auto-sync corrected discrepancy for ${product?.name}:`, {
        before: inventoryBefore.packs,
        after: calculatedInventory.packs,
        diff: calculatedInventory.packs - inventoryBefore.packs
      });
    }

    return {
      success: true,
      hadDiscrepancy,
      before: inventoryBefore ? {
        pallets: inventoryBefore.pallets,
        packs: inventoryBefore.packs,
        units: inventoryBefore.units
      } : null,
      after: calculatedInventory
    };

  } catch (error) {
    console.error(`❌ Error syncing inventory for product ${productId}:`, error.message);
    throw error;
  }
}

/**
 * Scan and sync ALL warehouse products
 * @param {string} triggeredBy - What triggered this scan
 * @returns {object} Scan results
 */
async function scanAndSyncAllProducts(triggeredBy = 'scheduled') {
  try {
    console.log(`\n🔄 Starting inventory sync scan (triggered by: ${triggeredBy})...`);

    // Get all warehouse products with inventory
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        module: 'WAREHOUSE',
        warehouseInventory: { some: {} }
      },
      select: { id: true, name: true, productNo: true }
    });

    let totalScanned = 0;
    let totalCorrected = 0;
    const correctedProducts = [];

    for (const product of products) {
      totalScanned++;

      const result = await syncProductInventory(product.id, null, triggeredBy);

      if (result.hadDiscrepancy) {
        totalCorrected++;
        correctedProducts.push({
          name: product.name,
          productNo: product.productNo,
          before: result.before,
          after: result.after
        });
      }
    }

    const summary = {
      timestamp: new Date().toISOString(),
      triggeredBy,
      totalScanned,
      totalCorrected,
      correctedProducts
    };

    if (totalCorrected > 0) {
      console.log(`⚠️  Inventory sync found and corrected ${totalCorrected} discrepancies out of ${totalScanned} products`);
      correctedProducts.forEach(p => {
        console.log(`   - ${p.name}: ${p.before.packs} → ${p.after.packs} packs (diff: ${p.after.packs - p.before.packs})`);
      });
    } else {
      console.log(`✅ Inventory sync complete: All ${totalScanned} products are in sync`);
    }

    return summary;

  } catch (error) {
    console.error('❌ Error in scanAndSyncAllProducts:', error.message);
    throw error;
  }
}

/**
 * Verify inventory integrity for a specific product
 * (Check if inventory matches batch data, but don't auto-correct)
 * @param {string} productId - The product ID to verify
 * @returns {object} Verification result
 */
async function verifyProductInventory(productId) {
  try {
    const inventory = await prisma.warehouseInventory.findFirst({
      where: { productId }
    });

    const batches = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId,
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
      }
    });

    const batchTotals = {
      pallets: 0,
      packs: 0,
      units: 0
    };

    batches.forEach(batch => {
      const remaining = batch.quantityRemaining || 0;
      if (batch.unitType === 'PALLETS') batchTotals.pallets += remaining;
      else if (batch.unitType === 'PACKS') batchTotals.packs += remaining;
      else if (batch.unitType === 'UNITS') batchTotals.units += remaining;
    });

    const hasDiscrepancy = inventory && (
      inventory.pallets !== batchTotals.pallets ||
      inventory.packs !== batchTotals.packs ||
      inventory.units !== batchTotals.units
    );

    return {
      hasDiscrepancy,
      inventory: inventory ? {
        pallets: inventory.pallets,
        packs: inventory.packs,
        units: inventory.units
      } : null,
      batches: batchTotals,
      discrepancy: hasDiscrepancy ? {
        pallets: batchTotals.pallets - inventory.pallets,
        packs: batchTotals.packs - inventory.packs,
        units: batchTotals.units - inventory.units
      } : null
    };

  } catch (error) {
    console.error(`❌ Error verifying inventory for product ${productId}:`, error.message);
    throw error;
  }
}

/**
 * Validate daily stock continuity
 * Ensures Opening Stock (Day N) = Closing Stock (Day N-1)
 * @param {string} productId - The product ID to validate
 * @param {Date} date - The date to validate
 * @returns {object} Validation result
 */
async function validateDailyContinuity(productId, date) {
  try {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const previousDay = new Date(date);
    previousDay.setDate(previousDay.getDate() - 1);
    const endOfPreviousDay = new Date(previousDay);
    endOfPreviousDay.setHours(23, 59, 59, 999);

    // Calculate closing stock for previous day
    const purchasesUpToPreviousDay = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId,
        purchaseDate: { lte: endOfPreviousDay },
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
        unitType: 'PACKS'
      }
    });

    const salesUpToPreviousDay = await prisma.warehouseSale.aggregate({
      where: {
        productId,
        createdAt: { lte: endOfPreviousDay },
        unitType: 'PACKS'
      },
      _sum: { quantity: true }
    });

    const closingStockPreviousDay =
      purchasesUpToPreviousDay.reduce((sum, p) => sum + p.quantity, 0) -
      (salesUpToPreviousDay._sum.quantity || 0);

    // Calculate opening stock for current day
    const purchasesBeforeCurrentDay = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId,
        purchaseDate: { lt: startOfDay },
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
        unitType: 'PACKS'
      }
    });

    const salesBeforeCurrentDay = await prisma.warehouseSale.aggregate({
      where: {
        productId,
        createdAt: { lt: startOfDay },
        unitType: 'PACKS'
      },
      _sum: { quantity: true }
    });

    const openingStockCurrentDay =
      purchasesBeforeCurrentDay.reduce((sum, p) => sum + p.quantity, 0) -
      (salesBeforeCurrentDay._sum.quantity || 0);

    // They should be equal
    const isValid = closingStockPreviousDay === openingStockCurrentDay;

    return {
      isValid,
      previousDay: previousDay.toISOString().split('T')[0],
      currentDay: date.toISOString().split('T')[0],
      closingStockPreviousDay,
      openingStockCurrentDay,
      discrepancy: isValid ? 0 : (openingStockCurrentDay - closingStockPreviousDay)
    };

  } catch (error) {
    console.error(`❌ Error validating daily continuity for product ${productId}:`, error.message);
    throw error;
  }
}

module.exports = {
  syncProductInventory,
  scanAndSyncAllProducts,
  verifyProductInventory,
  validateDailyContinuity
};
