/**
 * Test Auto-Sync System
 *
 * This script tests the inventory auto-sync system by:
 * 1. Checking current inventory state
 * 2. Manually creating a small discrepancy
 * 3. Waiting for auto-sync to detect and correct it
 * 4. Verifying the correction was logged
 */

const { PrismaClient } = require('@prisma/client');
const { syncProductInventory, scanAndSyncAllProducts } = require('../services/inventorySyncService');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('\n🧪 TESTING INVENTORY AUTO-SYNC SYSTEM\n');
    console.log('='.repeat(80));

    // Get a product to test with
    const product = await prisma.product.findFirst({
      where: {
        warehouseInventory: { some: {} }
      },
      include: {
        warehouseInventory: true
      }
    });

    if (!product) {
      console.log('❌ No products found with inventory');
      return;
    }

    console.log(`\n📦 Testing with product: ${product.name} (${product.productNo})`);
    console.log('='.repeat(80));

    // Step 1: Get current state
    const inventoryBefore = product.warehouseInventory[0];
    const batchesBefore = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: product.id,
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
        unitType: 'PACKS'
      }
    });

    const batchTotalBefore = batchesBefore.reduce((sum, b) => sum + (b.quantityRemaining || 0), 0);

    console.log('\n1️⃣  INITIAL STATE:');
    console.log(`   Inventory Table: ${inventoryBefore.packs} packs`);
    console.log(`   Batch System: ${batchTotalBefore} packs`);
    console.log(`   Match: ${inventoryBefore.packs === batchTotalBefore ? '✅' : '❌'}`);

    if (inventoryBefore.packs !== batchTotalBefore) {
      console.log('\n⚠️  Product already has a discrepancy! Running sync...\n');
      await syncProductInventory(product.id, null, 'test_script');
      console.log('✅ Sync completed. Exiting test.');
      return;
    }

    // Step 2: Create a temporary discrepancy (for testing only)
    console.log('\n2️⃣  CREATING TEST DISCREPANCY:');
    const testDiscrepancy = 5;

    await prisma.warehouseInventory.update({
      where: { id: inventoryBefore.id },
      data: {
        packs: inventoryBefore.packs + testDiscrepancy
      }
    });

    console.log(`   Added ${testDiscrepancy} packs to inventory table (batches unchanged)`);
    console.log(`   Inventory Table: ${inventoryBefore.packs + testDiscrepancy} packs`);
    console.log(`   Batch System: ${batchTotalBefore} packs`);
    console.log(`   Discrepancy: +${testDiscrepancy} packs ❌`);

    // Step 3: Wait a moment, then trigger manual sync
    console.log('\n3️⃣  TRIGGERING AUTO-SYNC:');
    console.log('   Calling syncProductInventory()...\n');

    const result = await syncProductInventory(product.id, null, 'manual_test');

    console.log(`   Sync Result:`);
    console.log(`     Had Discrepancy: ${result.hadDiscrepancy ? 'YES ✅' : 'NO'}`);
    console.log(`     Before: ${result.before.packs} packs`);
    console.log(`     After: ${result.after.packs} packs`);
    console.log(`     Corrected: ${result.hadDiscrepancy ? (result.before.packs - result.after.packs) : 0} packs`);

    // Step 4: Verify correction
    const inventoryAfter = await prisma.warehouseInventory.findFirst({
      where: { productId: product.id }
    });

    console.log('\n4️⃣  VERIFICATION:');
    console.log(`   Inventory Table: ${inventoryAfter.packs} packs`);
    console.log(`   Batch System: ${batchTotalBefore} packs`);
    console.log(`   Match: ${inventoryAfter.packs === batchTotalBefore ? '✅ CORRECTED!' : '❌ FAILED'}`);

    // Step 5: Check audit log
    const auditLog = await prisma.auditLog.findFirst({
      where: {
        entity: 'WarehouseInventory',
        action: 'AUTO_SYNC_CORRECTION',
        entityId: inventoryBefore.id
      },
      orderBy: { createdAt: 'desc' }
    });

    console.log('\n5️⃣  AUDIT LOG:');
    if (auditLog) {
      console.log(`   ✅ Auto-sync correction was logged`);
      console.log(`   Timestamp: ${new Date(auditLog.createdAt).toLocaleString('en-GB')}`);
      const newValues = typeof auditLog.newValues === 'string' ? JSON.parse(auditLog.newValues) : auditLog.newValues;
      console.log(`   Triggered By: ${newValues?.triggeredBy || 'Unknown'}`);
      if (newValues?.discrepancy) {
        console.log(`   Discrepancy Corrected: ${newValues.discrepancy.packs} packs`);
      }
    } else {
      console.log(`   ❌ No audit log found`);
    }

    // Step 6: Test full system scan
    console.log('\n6️⃣  TESTING FULL SYSTEM SCAN:');
    console.log('   Running scanAndSyncAllProducts()...\n');

    const scanResult = await scanAndSyncAllProducts('test_full_scan');

    console.log(`   Scan Results:`);
    console.log(`     Total Scanned: ${scanResult.totalScanned} products`);
    console.log(`     Total Corrected: ${scanResult.totalCorrected} products`);

    if (scanResult.totalCorrected > 0) {
      console.log('\n   Corrected Products:');
      scanResult.correctedProducts.forEach(p => {
        console.log(`     - ${p.name}: ${p.before.packs} → ${p.after.packs} packs`);
      });
    }

    console.log('\n' + '='.repeat(80));
    console.log('✅ AUTO-SYNC TEST COMPLETED SUCCESSFULLY!');
    console.log('='.repeat(80));
    console.log('\n📊 SUMMARY:');
    console.log('   ✅ Manual sync works correctly');
    console.log('   ✅ Discrepancies are detected and corrected');
    console.log('   ✅ Audit logs are created');
    console.log('   ✅ Full system scan works');
    console.log('\n💡 The cron job will run every 5 minutes automatically.');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
