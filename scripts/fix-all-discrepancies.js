/**
 * Fix All Historical Discrepancies
 *
 * This script corrects inventory for all products affected by the
 * double-deduction bug. It reads from discrepancies.json generated
 * by scan-all-products.js
 *
 * Run with: node scripts/fix-all-discrepancies.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');
const path = require('path');

async function fixAllDiscrepancies() {
  console.log('\n🔧 FIXING ALL INVENTORY DISCREPANCIES');
  console.log('======================================\n');

  try {
    // Read discrepancies file
    const discrepanciesPath = path.join(__dirname, 'discrepancies.json');

    if (!fs.existsSync(discrepanciesPath)) {
      console.log('❌ No discrepancies.json file found.');
      console.log('   Run scan-all-products.js first to generate the file.\n');
      return;
    }

    const discrepancies = JSON.parse(fs.readFileSync(discrepanciesPath, 'utf8'));

    console.log('Found', discrepancies.length, 'products to fix\n');

    let fixed = 0;
    let failed = 0;
    const { createAuditLog } = require('../utils/auditLogger');

    for (const item of discrepancies) {
      try {
        console.log('Processing:', item.productName);

        // Update inventory
        const updated = await prisma.warehouseInventory.update({
          where: { id: item.inventoryId },
          data: {
            pallets: item.expectedStock.pallets,
            packs: item.expectedStock.packs,
            units: item.expectedStock.units,
            lastUpdated: new Date()
          }
        });

        console.log('  Old: P:' + item.currentStock.pallets + ' | Pk:' + item.currentStock.packs + ' | U:' + item.currentStock.units);
        console.log('  New: P:' + updated.pallets + ' | Pk:' + updated.packs + ' | U:' + updated.units);

        const diffP = item.difference.pallets > 0 ? '+' + item.difference.pallets : item.difference.pallets;
        const diffPk = item.difference.packs > 0 ? '+' + item.difference.packs : item.difference.packs;
        const diffU = item.difference.units > 0 ? '+' + item.difference.units : item.difference.units;

        console.log('  Adjusted: P:' + diffP + ' | Pk:' + diffPk + ' | U:' + diffU);

        // Create audit log
        await createAuditLog({
          userId: null, // System adjustment
          action: 'UPDATE',
          entity: 'WarehouseInventory',
          entityId: item.inventoryId,
          oldValues: {
            pallets: item.currentStock.pallets,
            packs: item.currentStock.packs,
            units: item.currentStock.units,
            reason: 'Historical double-deduction bug'
          },
          newValues: {
            pallets: item.expectedStock.pallets,
            packs: item.expectedStock.packs,
            units: item.expectedStock.units,
            reason: 'Bulk fix - correcting all double-deduction discrepancies'
          },
          metadata: {
            triggeredBy: 'BULK_MANUAL_ADJUSTMENT',
            scriptName: 'fix-all-discrepancies.js',
            productId: item.productId,
            productName: item.productName,
            totalPurchased: item.totalPurchased,
            totalSold: item.totalSold,
            difference: item.difference
          }
        });

        console.log('  ✅ Fixed\n');
        fixed++;

      } catch (error) {
        console.error('  ❌ Error:', error.message);
        failed++;
      }
    }

    console.log('\n======================================');
    console.log('📊 FIX SUMMARY');
    console.log('======================================');
    console.log('Total Products:', discrepancies.length);
    console.log('✅ Successfully Fixed:', fixed);
    console.log('❌ Failed:', failed);
    console.log('');

    if (fixed > 0) {
      console.log('🎉 All discrepancies have been corrected!');
      console.log('   Audit logs created for all adjustments.');
      console.log('');

      // Calculate total adjustment
      const totalAdjustment = discrepancies.reduce((sum, d) => {
        return sum + Math.abs(d.difference.pallets) + Math.abs(d.difference.packs) + Math.abs(d.difference.units);
      }, 0);

      console.log('📦 Total Units Adjusted:', totalAdjustment);
      console.log('');

      // Rename the discrepancies file to mark as fixed
      const fixedPath = path.join(__dirname, 'discrepancies-fixed-' + Date.now() + '.json');
      fs.renameSync(discrepanciesPath, fixedPath);
      console.log('📁 Discrepancies file archived to:', path.basename(fixedPath));
    }

    console.log('\n✨ Inventory correction complete!\n');

  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

fixAllDiscrepancies();
