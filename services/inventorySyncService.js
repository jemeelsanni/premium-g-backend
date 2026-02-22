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

/**
 * Validate batch quantity_sold matches actual sales records
 * This catches discrepancies where sales were recorded but batch wasn't updated (or vice versa)
 * @param {string} productId - The product ID to validate
 * @returns {object} Validation result with discrepancy details
 */
async function validateBatchSalesConsistency(productId) {
  try {
    // Get sum of quantity_sold from all batches for this product
    const batchSoldResult = await prisma.warehouseProductPurchase.aggregate({
      where: { productId },
      _sum: { quantitySold: true }
    });
    const batchQuantitySold = batchSoldResult._sum.quantitySold || 0;

    // Get sum of actual sales for this product
    const actualSalesResult = await prisma.warehouseSale.aggregate({
      where: { productId },
      _sum: { quantity: true }
    });
    const actualSalesQty = actualSalesResult._sum.quantity || 0;

    const discrepancy = batchQuantitySold - actualSalesQty;
    const hasDiscrepancy = discrepancy !== 0;

    return {
      productId,
      batchQuantitySold,
      actualSalesQty,
      discrepancy,
      hasDiscrepancy,
      issue: hasDiscrepancy
        ? (discrepancy > 0
            ? 'Batch over-counted (more sold in batches than actual sales)'
            : 'Sales not reflected in batches (sales missing from batch deductions)')
        : null
    };

  } catch (error) {
    console.error(`❌ Error validating batch-sales consistency for product ${productId}:`, error.message);
    throw error;
  }
}

/**
 * Fix batch-sales discrepancies by recalculating batch data from actual sales
 * Uses FEFO (First Expired, First Out) to reallocate sales to batches
 * @param {string} productId - The product ID to fix
 * @param {string} triggeredBy - What triggered this fix
 * @returns {object} Fix result with before/after values
 */
async function fixBatchSalesDiscrepancy(productId, triggeredBy = 'manual') {
  try {
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { name: true, productNo: true }
    });

    // Get current state for audit logging
    const beforeState = await validateBatchSalesConsistency(productId);

    if (!beforeState.hasDiscrepancy) {
      return {
        success: true,
        fixed: false,
        message: 'No discrepancy to fix',
        product: product?.name
      };
    }

    // Get total actual sales
    const totalSales = beforeState.actualSalesQty;

    // Get all batches ordered by expiry date (FEFO) then by purchase date
    const batches = await prisma.warehouseProductPurchase.findMany({
      where: { productId },
      orderBy: [
        { expiryDate: 'asc' },
        { purchaseDate: 'asc' }
      ]
    });

    if (batches.length === 0) {
      console.log(`⚠️  No batches found for product ${product?.name}`);
      return {
        success: false,
        fixed: false,
        message: 'No batches found for product',
        product: product?.name
      };
    }

    // Reallocate sales to batches using FEFO
    let remainingSalesToAllocate = totalSales;
    const batchUpdates = [];

    for (const batch of batches) {
      const maxCanSellFromBatch = batch.quantity; // Total quantity in this batch
      const allocatedToBatch = Math.min(remainingSalesToAllocate, maxCanSellFromBatch);

      const newQuantitySold = allocatedToBatch;
      const newQuantityRemaining = batch.quantity - newQuantitySold;
      const newBatchStatus = newQuantityRemaining === 0 ? 'DEPLETED' :
                             (batch.expiryDate && batch.expiryDate < new Date() ? 'EXPIRED' : 'ACTIVE');

      batchUpdates.push({
        id: batch.id,
        batchNumber: batch.batchNumber,
        oldQuantitySold: batch.quantitySold,
        oldQuantityRemaining: batch.quantityRemaining,
        oldBatchStatus: batch.batchStatus,
        newQuantitySold,
        newQuantityRemaining,
        newBatchStatus
      });

      remainingSalesToAllocate -= allocatedToBatch;

      if (remainingSalesToAllocate <= 0) break;
    }

    // Apply batch updates in a transaction with extended timeout
    await prisma.$transaction(async (tx) => {
      for (const update of batchUpdates) {
        await tx.warehouseProductPurchase.update({
          where: { id: update.id },
          data: {
            quantitySold: update.newQuantitySold,
            quantityRemaining: update.newQuantityRemaining,
            batchStatus: update.newBatchStatus
          }
        });
      }

      // Log the fix in audit log
      await tx.auditLog.create({
        data: {
          entity: 'WarehouseProductPurchase',
          entityId: productId,
          action: 'BATCH_SALES_DISCREPANCY_FIX',
          oldValues: {
            productName: product?.name,
            productNo: product?.productNo,
            triggeredBy,
            batchQuantitySold: beforeState.batchQuantitySold,
            actualSalesQty: beforeState.actualSalesQty,
            discrepancy: beforeState.discrepancy,
            issue: beforeState.issue
          },
          newValues: {
            productName: product?.name,
            productNo: product?.productNo,
            triggeredBy,
            batchQuantitySold: totalSales,
            actualSalesQty: totalSales,
            discrepancy: 0,
            batchesUpdated: batchUpdates.length,
            updates: batchUpdates.map(u => ({
              batchNumber: u.batchNumber,
              soldChange: u.newQuantitySold - u.oldQuantitySold,
              remainingChange: u.newQuantityRemaining - u.oldQuantityRemaining
            }))
          }
        }
      });
    }, {
      timeout: 60000 // 60 second timeout for large batch updates
    });

    // Now sync inventory to match the corrected batch data
    await syncProductInventory(productId, null, `${triggeredBy}_batch_fix`);

    const afterState = await validateBatchSalesConsistency(productId);

    console.log(`✅ Fixed batch-sales discrepancy for ${product?.name}:`, {
      before: beforeState.discrepancy,
      after: afterState.discrepancy,
      batchesUpdated: batchUpdates.length
    });

    return {
      success: true,
      fixed: true,
      product: product?.name,
      before: beforeState,
      after: afterState,
      batchesUpdated: batchUpdates.length
    };

  } catch (error) {
    console.error(`❌ Error fixing batch-sales discrepancy for product ${productId}:`, error.message);
    throw error;
  }
}

/**
 * Scan all products for batch-sales discrepancies and optionally fix them
 * @param {string} triggeredBy - What triggered this scan
 * @param {boolean} autoFix - Whether to automatically fix discrepancies (default: true)
 * @returns {object} Scan results
 */
async function scanAndFixBatchSalesDiscrepancies(triggeredBy = 'scheduled', autoFix = true) {
  try {
    console.log(`\n🔍 Starting batch-sales consistency scan (triggered by: ${triggeredBy})...`);

    // Get all products that have either batches or sales
    const productsWithBatches = await prisma.warehouseProductPurchase.findMany({
      select: { productId: true },
      distinct: ['productId']
    });

    const productsWithSales = await prisma.warehouseSale.findMany({
      select: { productId: true },
      distinct: ['productId']
    });

    // Combine and deduplicate product IDs
    const allProductIds = [...new Set([
      ...productsWithBatches.map(p => p.productId),
      ...productsWithSales.map(p => p.productId)
    ])];

    // Get product details
    const productsWithActivity = await prisma.product.findMany({
      where: { id: { in: allProductIds } },
      select: { id: true, name: true, productNo: true }
    });

    let totalScanned = 0;
    let totalWithDiscrepancy = 0;
    let totalFixed = 0;
    const discrepancies = [];

    for (const product of productsWithActivity) {
      totalScanned++;

      const validation = await validateBatchSalesConsistency(product.id);

      if (validation.hasDiscrepancy) {
        totalWithDiscrepancy++;

        if (autoFix) {
          const fixResult = await fixBatchSalesDiscrepancy(product.id, triggeredBy);
          if (fixResult.fixed) {
            totalFixed++;
          }
          discrepancies.push({
            product: product.name,
            ...validation,
            fixed: fixResult.fixed
          });
        } else {
          discrepancies.push({
            product: product.name,
            ...validation,
            fixed: false
          });
        }
      }
    }

    const summary = {
      timestamp: new Date().toISOString(),
      triggeredBy,
      autoFix,
      totalScanned,
      totalWithDiscrepancy,
      totalFixed,
      discrepancies
    };

    if (totalWithDiscrepancy > 0) {
      console.log(`⚠️  Batch-sales scan found ${totalWithDiscrepancy} discrepancies out of ${totalScanned} products`);
      if (autoFix) {
        console.log(`   ✅ Fixed ${totalFixed} discrepancies`);
      }
      discrepancies.forEach(d => {
        console.log(`   - ${d.product}: batch=${d.batchQuantitySold}, sales=${d.actualSalesQty}, diff=${d.discrepancy} ${d.fixed ? '(FIXED)' : ''}`);
      });
    } else {
      console.log(`✅ Batch-sales scan complete: All ${totalScanned} products are consistent`);
    }

    return summary;

  } catch (error) {
    console.error('❌ Error in scanAndFixBatchSalesDiscrepancies:', error.message);
    throw error;
  }
}

/**
 * Enhanced scan that runs both inventory sync AND batch-sales validation
 * @param {string} triggeredBy - What triggered this scan
 * @returns {object} Combined scan results
 */
async function fullInventoryAudit(triggeredBy = 'scheduled') {
  console.log(`\n🔄 Starting FULL inventory audit (triggered by: ${triggeredBy})...`);
  console.log('━'.repeat(60));

  // Step 1: Validate and fix batch-sales discrepancies
  const batchSalesResult = await scanAndFixBatchSalesDiscrepancies(triggeredBy, true);

  // Step 2: Sync inventory with batch data (after batch data is corrected)
  const inventorySyncResult = await scanAndSyncAllProducts(triggeredBy);

  const summary = {
    timestamp: new Date().toISOString(),
    triggeredBy,
    batchSalesCheck: {
      scanned: batchSalesResult.totalScanned,
      discrepanciesFound: batchSalesResult.totalWithDiscrepancy,
      fixed: batchSalesResult.totalFixed
    },
    inventorySync: {
      scanned: inventorySyncResult.totalScanned,
      corrected: inventorySyncResult.totalCorrected
    }
  };

  console.log('━'.repeat(60));
  console.log('📊 Full inventory audit summary:', summary);

  return summary;
}

/**
 * Comprehensive batch integrity validation
 * Checks all aspects of batch data for inconsistencies
 * @returns {object} Validation report
 */
async function validateBatchIntegrity() {
  console.log('\n🔍 Running comprehensive batch integrity check...');

  const issues = [];

  // 1. Check for batches where quantity != quantitySold + quantityRemaining
  const quantityMismatch = await prisma.$queryRaw`
    SELECT
      p.name as product_name,
      wpp.batch_number,
      wpp.quantity,
      wpp.quantity_sold,
      wpp.quantity_remaining,
      (wpp.quantity - wpp.quantity_sold - wpp.quantity_remaining) as discrepancy
    FROM warehouse_product_purchases wpp
    JOIN products p ON p.id = wpp.product_id
    WHERE wpp.quantity != wpp.quantity_sold + wpp.quantity_remaining
  `;

  if (quantityMismatch.length > 0) {
    issues.push({
      type: 'QUANTITY_MISMATCH',
      description: 'Batches where quantity != quantitySold + quantityRemaining',
      count: quantityMismatch.length,
      details: quantityMismatch
    });
  }

  // 2. Check for negative quantities
  const negativeQuantities = await prisma.$queryRaw`
    SELECT
      p.name as product_name,
      wpp.batch_number,
      wpp.quantity_sold,
      wpp.quantity_remaining
    FROM warehouse_product_purchases wpp
    JOIN products p ON p.id = wpp.product_id
    WHERE wpp.quantity_sold < 0 OR wpp.quantity_remaining < 0
  `;

  if (negativeQuantities.length > 0) {
    issues.push({
      type: 'NEGATIVE_QUANTITIES',
      description: 'Batches with negative sold or remaining quantities',
      count: negativeQuantities.length,
      details: negativeQuantities
    });
  }

  // 3. Check for batch-sales record mismatches
  const batchSalesMismatch = await prisma.$queryRaw`
    SELECT
      p.name as product_name,
      wpp.batch_number,
      wpp.quantity_sold as batch_qty_sold,
      COALESCE(SUM(wbs.quantity_sold), 0) as tracked_qty_sold,
      wpp.quantity_sold - COALESCE(SUM(wbs.quantity_sold), 0) as discrepancy
    FROM warehouse_product_purchases wpp
    JOIN products p ON p.id = wpp.product_id
    LEFT JOIN warehouse_batch_sales wbs ON wbs.batch_id = wpp.id
    GROUP BY wpp.id, p.name, wpp.batch_number, wpp.quantity_sold
    HAVING wpp.quantity_sold != COALESCE(SUM(wbs.quantity_sold), 0)
  `;

  if (batchSalesMismatch.length > 0) {
    issues.push({
      type: 'BATCH_SALES_MISMATCH',
      description: 'Batches where quantitySold doesnt match warehouseBatchSales records',
      count: batchSalesMismatch.length,
      details: batchSalesMismatch
    });
  }

  // 4. Check for orphan sales (sales without batch allocations)
  const orphanSales = await prisma.$queryRaw`
    SELECT
      ws.id,
      ws.receipt_number,
      p.name as product_name,
      ws.quantity,
      ws.created_at
    FROM warehouse_sales ws
    JOIN products p ON p.id = ws.product_id
    LEFT JOIN warehouse_batch_sales wbs ON wbs.sale_id = ws.id
    WHERE wbs.id IS NULL
  `;

  if (orphanSales.length > 0) {
    issues.push({
      type: 'ORPHAN_SALES',
      description: 'Sales without batch allocation records',
      count: orphanSales.length,
      details: orphanSales
    });
  }

  // 5. Check inventory vs batch remaining mismatch
  const inventoryMismatch = await prisma.$queryRaw`
    SELECT
      p.name as product_name,
      wi.packs as inventory_packs,
      COALESCE(SUM(wpp.quantity_remaining), 0) as batch_remaining,
      wi.packs - COALESCE(SUM(wpp.quantity_remaining), 0) as discrepancy
    FROM warehouse_inventory wi
    JOIN products p ON p.id = wi.product_id
    LEFT JOIN warehouse_product_purchases wpp ON wpp.product_id = wi.product_id
      AND wpp.batch_status IN ('ACTIVE', 'DEPLETED')
      AND wpp.unit_type = 'PACKS'
    GROUP BY wi.product_id, p.name, wi.packs
    HAVING wi.packs != COALESCE(SUM(wpp.quantity_remaining), 0)
  `;

  if (inventoryMismatch.length > 0) {
    issues.push({
      type: 'INVENTORY_BATCH_MISMATCH',
      description: 'Inventory doesnt match sum of batch remaining',
      count: inventoryMismatch.length,
      details: inventoryMismatch
    });
  }

  const summary = {
    timestamp: new Date().toISOString(),
    hasIssues: issues.length > 0,
    totalIssues: issues.reduce((sum, i) => sum + i.count, 0),
    issueTypes: issues.length,
    issues
  };

  if (issues.length > 0) {
    console.log(`⚠️  Found ${summary.totalIssues} integrity issues across ${issues.length} categories`);
    issues.forEach(issue => {
      console.log(`   - ${issue.type}: ${issue.count} issues`);
    });
  } else {
    console.log('✅ All batch integrity checks passed!');
  }

  return summary;
}

/**
 * Get a summary of stock health across all products
 * Useful for dashboard/reporting
 * @returns {object} Stock health summary
 */
async function getStockHealthSummary() {
  const products = await prisma.product.findMany({
    where: {
      module: 'WAREHOUSE',
      isActive: true,
      warehouseInventory: { some: {} }
    },
    include: {
      warehouseInventory: true,
      warehouseProductPurchases: {
        where: { batchStatus: { in: ['ACTIVE', 'DEPLETED'] } }
      }
    }
  });

  const summary = {
    totalProducts: products.length,
    healthyProducts: 0,
    productsWithIssues: 0,
    totalBatches: 0,
    activeBatches: 0,
    depletedBatches: 0,
    issues: []
  };

  for (const product of products) {
    const inventory = product.warehouseInventory[0];
    const batches = product.warehouseProductPurchases;

    summary.totalBatches += batches.length;
    summary.activeBatches += batches.filter(b => b.batchStatus === 'ACTIVE').length;
    summary.depletedBatches += batches.filter(b => b.batchStatus === 'DEPLETED').length;

    // Calculate expected inventory from batches
    const expectedPacks = batches
      .filter(b => b.unitType === 'PACKS')
      .reduce((sum, b) => sum + b.quantityRemaining, 0);

    const hasIssue = inventory?.packs !== expectedPacks;

    if (hasIssue) {
      summary.productsWithIssues++;
      summary.issues.push({
        product: product.name,
        inventoryPacks: inventory?.packs || 0,
        expectedPacks,
        discrepancy: (inventory?.packs || 0) - expectedPacks
      });
    } else {
      summary.healthyProducts++;
    }
  }

  return summary;
}

module.exports = {
  syncProductInventory,
  scanAndSyncAllProducts,
  verifyProductInventory,
  validateDailyContinuity,
  validateBatchSalesConsistency,
  fixBatchSalesDiscrepancy,
  scanAndFixBatchSalesDiscrepancies,
  fullInventoryAudit,
  validateBatchIntegrity,
  getStockHealthSummary
};
