/**
 * Fix Historical 2-Pack Discrepancy for 35CL BIGI
 *
 * This script corrects the 2-pack difference caused by historical double-deductions
 * that occurred before the bug fix was implemented on Dec 15, 2025.
 *
 * The discrepancy exists because:
 * - Batch system shows: 2,500 packs sold
 * - Actual sales table shows: 2,498 packs sold
 * - Difference: 2 packs were double-deducted before the fix
 *
 * Run with: node scripts/fix-historical-discrepancy.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixHistoricalDiscrepancy() {
  console.log('\n🔧 FIXING HISTORICAL 2-PACK DISCREPANCY');
  console.log('========================================\n');

  try {
    // Find 35CL BIGI
    const product = await prisma.product.findFirst({
      where: {
        name: { contains: '35cl', mode: 'insensitive' },
        module: 'WAREHOUSE'
      },
      include: {
        warehouseInventory: true
      }
    });

    if (!product) {
      console.log('❌ Product not found');
      return;
    }

    console.log('Product:', product.name);
    console.log('Current Inventory:', product.warehouseInventory[0]?.packs, 'packs');

    // Calculate what it should be
    const allPurchases = await prisma.warehouseProductPurchase.findMany({
      where: { productId: product.id, unitType: 'PACKS' }
    });

    const allSales = await prisma.warehouseSale.findMany({
      where: { productId: product.id, unitType: 'PACKS' }
    });

    const totalPurchased = allPurchases.reduce((sum, p) => sum + p.quantity, 0);
    const totalSold = allSales.reduce((sum, s) => sum + s.quantity, 0);
    const shouldBe = totalPurchased - totalSold;

    console.log('\nCalculation:');
    console.log('  Total Purchased:', totalPurchased);
    console.log('  Total Sold:', totalSold);
    console.log('  Should Be:', shouldBe);
    console.log('  Current:', product.warehouseInventory[0]?.packs);
    console.log('  Difference:', shouldBe - product.warehouseInventory[0]?.packs);

    if (shouldBe === product.warehouseInventory[0]?.packs) {
      console.log('\n✅ No adjustment needed - inventory is correct!');
      return;
    }

    // Perform the adjustment
    const difference = shouldBe - product.warehouseInventory[0]?.packs;

    console.log('\n🔄 Applying adjustment of +', difference, 'packs...');

    const updated = await prisma.warehouseInventory.update({
      where: { id: product.warehouseInventory[0].id },
      data: {
        packs: shouldBe,
        lastUpdated: new Date()
      }
    });

    console.log('✅ Adjustment completed!');
    console.log('   Old:', product.warehouseInventory[0]?.packs, 'packs');
    console.log('   New:', updated.packs, 'packs');

    // Create audit log for this manual adjustment
    const { createAuditLog } = require('../utils/auditLogger');

    await createAuditLog({
      userId: null, // System adjustment
      action: 'UPDATE',
      entity: 'WarehouseInventory',
      entityId: product.warehouseInventory[0].id,
      oldValues: {
        packs: product.warehouseInventory[0]?.packs,
        reason: 'Pre-fix historical discrepancy'
      },
      newValues: {
        packs: updated.packs,
        reason: 'Manual correction of 2-pack historical double-deduction'
      },
      metadata: {
        triggeredBy: 'MANUAL_ADJUSTMENT',
        scriptName: 'fix-historical-discrepancy.js',
        description: 'Correcting 2-pack discrepancy from double-deduction bug that existed before Dec 15, 2025 fix',
        totalPurchased,
        totalSold,
        expectedStock: shouldBe,
        adjustment: difference
      }
    });

    console.log('\n📝 Audit log created for this adjustment');
    console.log('\n✨ Historical discrepancy resolved!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

fixHistoricalDiscrepancy();
