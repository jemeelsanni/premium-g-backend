const { PrismaClient } = require('@prisma/client');
const { createAuditLog } = require('../utils/auditLogger');
const prisma = new PrismaClient();

(async () => {
  try {
    // Get 35CL BIGI product
    const product = await prisma.product.findFirst({
      where: { name: { contains: '35CL BIGI' } }
    });

    if (!product) {
      console.log('❌ Product not found');
      return;
    }

    console.log('\n🔧 FIXING 2-PACK HISTORICAL DISCREPANCY - 35CL BIGI\n');
    console.log('='.repeat(80));

    // Calculate current status
    const allPurchases = await prisma.warehouseProductPurchase.aggregate({
      where: {
        productId: product.id,
        unitType: 'PACKS',
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
      },
      _sum: {
        quantity: true,
        quantitySold: true,
        quantityRemaining: true
      }
    });

    const allSales = await prisma.warehouseSale.aggregate({
      where: {
        productId: product.id,
        unitType: 'PACKS'
      },
      _sum: { quantity: true }
    });

    const batchSalesTotal = await prisma.warehouseBatchSale.aggregate({
      where: {
        sale: {
          productId: product.id,
          unitType: 'PACKS'
        }
      },
      _sum: { quantitySold: true }
    });

    console.log('\nCurrent Status:');
    console.log('  Total Purchased: ' + (allPurchases._sum.quantity || 0) + ' packs');
    console.log('  Total Sold (sales table): ' + (allSales._sum.quantity || 0) + ' packs');
    console.log('  Total Sold (batch sales table): ' + (batchSalesTotal._sum.quantitySold || 0) + ' packs');
    console.log('  Total Sold (batch quantitySold): ' + (allPurchases._sum.quantitySold || 0) + ' packs');
    console.log('  Total Remaining: ' + (allPurchases._sum.quantityRemaining || 0) + ' packs');

    const expectedRemaining = (allPurchases._sum.quantity || 0) - (allSales._sum.quantity || 0);
    const actualRemaining = allPurchases._sum.quantityRemaining || 0;
    const discrepancy = expectedRemaining - actualRemaining;

    console.log('\n  Expected Remaining: ' + expectedRemaining + ' packs');
    console.log('  Discrepancy: ' + discrepancy + ' packs ' + (discrepancy > 0 ? 'missing' : 'excess'));

    if (discrepancy === 0) {
      console.log('\n✅ No discrepancy found! Inventory is already correct.');
      return;
    }

    if (discrepancy !== 2) {
      console.log('\n⚠️  Expected 2-pack discrepancy, but found ' + discrepancy + ' packs');
      console.log('   Please review manually.');
      return;
    }

    console.log('\n📝 Fixing discrepancy by reducing quantitySold and increasing quantityRemaining...');

    // Find the oldest active batch to adjust
    const oldestBatch = await prisma.warehouseProductPurchase.findFirst({
      where: {
        productId: product.id,
        unitType: 'PACKS',
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
      },
      orderBy: { expiryDate: 'asc' }
    });

    if (!oldestBatch) {
      console.log('❌ No batch found to adjust');
      return;
    }

    console.log('\nAdjusting Batch:');
    console.log('  Batch Number: ' + oldestBatch.batchNumber);
    console.log('  Expiry: ' + new Date(oldestBatch.expiryDate).toLocaleDateString('en-GB'));
    console.log('  Current quantitySold: ' + oldestBatch.quantitySold);
    console.log('  Current quantityRemaining: ' + oldestBatch.quantityRemaining);
    console.log('  New quantitySold: ' + (oldestBatch.quantitySold - 2));
    console.log('  New quantityRemaining: ' + (oldestBatch.quantityRemaining + 2));

    // Perform the fix
    const updatedBatch = await prisma.warehouseProductPurchase.update({
      where: { id: oldestBatch.id },
      data: {
        quantitySold: { decrement: 2 },
        quantityRemaining: { increment: 2 },
        batchStatus: 'ACTIVE'
      }
    });

    // Sync inventory
    const allBatches = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: product.id,
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
      }
    });

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

    await prisma.warehouseInventory.updateMany({
      where: { productId: product.id },
      data: {
        pallets: calculatedInventory.pallets,
        packs: calculatedInventory.packs,
        units: calculatedInventory.units,
        lastUpdated: new Date()
      }
    });

    // Create audit log
    await createAuditLog({
      userId: null,
      action: 'UPDATE',
      entity: 'WarehouseProductPurchase',
      entityId: oldestBatch.id,
      oldValues: {
        batchNumber: oldestBatch.batchNumber,
        quantitySold: oldestBatch.quantitySold,
        quantityRemaining: oldestBatch.quantityRemaining
      },
      newValues: {
        batchNumber: updatedBatch.batchNumber,
        quantitySold: updatedBatch.quantitySold,
        quantityRemaining: updatedBatch.quantityRemaining
      },
      metadata: {
        triggeredBy: 'MANUAL_ADJUSTMENT',
        scriptName: 'fix-2-pack-discrepancy.js',
        reason: 'Historical double-deduction correction',
        productId: product.id,
        productName: product.name
      }
    });

    console.log('\n✅ Fixed! Inventory updated to: ' + calculatedInventory.packs + ' packs');
    console.log('📝 Audit log created\n');

    // Verify
    const verification = await prisma.warehouseProductPurchase.aggregate({
      where: {
        productId: product.id,
        unitType: 'PACKS',
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
      },
      _sum: {
        quantity: true,
        quantitySold: true,
        quantityRemaining: true
      }
    });

    console.log('Verification:');
    console.log('  Total Purchased: ' + (verification._sum.quantity || 0) + ' packs');
    console.log('  Total Sold: ' + (verification._sum.quantitySold || 0) + ' packs');
    console.log('  Total Remaining: ' + (verification._sum.quantityRemaining || 0) + ' packs');
    console.log('  Expected: ' + expectedRemaining + ' packs');
    console.log('  ' + (verification._sum.quantityRemaining === expectedRemaining ? '✅ MATCH!' : '❌ MISMATCH'));
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
