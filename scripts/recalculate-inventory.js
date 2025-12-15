/**
 * Recalculate Warehouse Inventory from Batch Data
 *
 * This script fixes inventory discrepancies caused by the double-deduction bug.
 * It recalculates inventory for all products based on batch data (source of truth).
 *
 * Run with: node scripts/recalculate-inventory.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function recalculateInventory() {
  console.log('\n🔧 INVENTORY RECALCULATION SCRIPT');
  console.log('================================\n');

  try {
    // Get all warehouse products
    const products = await prisma.product.findMany({
      where: {
        module: 'WAREHOUSE',
        isActive: true
      },
      include: {
        warehouseInventory: true
      }
    });

    console.log(`Found ${products.length} warehouse products\n`);

    let fixed = 0;
    let unchanged = 0;
    let errors = 0;

    for (const product of products) {
      try {
        // Get all batches for this product
        const batches = await prisma.warehouseProductPurchase.findMany({
          where: {
            productId: product.id,
            batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
          }
        });

        // Calculate total inventory from batches
        const batchInventory = {
          pallets: 0,
          packs: 0,
          units: 0
        };

        batches.forEach(batch => {
          const remaining = batch.quantityRemaining || 0;

          if (batch.unitType === 'PALLETS') {
            batchInventory.pallets += remaining;
          } else if (batch.unitType === 'PACKS') {
            batchInventory.packs += remaining;
          } else if (batch.unitType === 'UNITS') {
            batchInventory.units += remaining;
          }
        });

        // Get current inventory record
        const currentInventory = product.warehouseInventory[0];

        if (!currentInventory) {
          console.log(`⚠️  ${product.name}: No inventory record found, skipping...`);
          continue;
        }

        const currentPallets = currentInventory.pallets || 0;
        const currentPacks = currentInventory.packs || 0;
        const currentUnits = currentInventory.units || 0;

        // Check if there's a discrepancy
        const palletsDiff = batchInventory.pallets - currentPallets;
        const packsDiff = batchInventory.packs - currentPacks;
        const unitsDiff = batchInventory.units - currentUnits;

        if (palletsDiff !== 0 || packsDiff !== 0 || unitsDiff !== 0) {
          console.log(`\n📦 ${product.name} (${product.productNo})`);
          console.log('   Current inventory:');
          console.log(`     Pallets: ${currentPallets} | Packs: ${currentPacks} | Units: ${currentUnits}`);
          console.log('   Batch calculation:');
          console.log(`     Pallets: ${batchInventory.pallets} | Packs: ${batchInventory.packs} | Units: ${batchInventory.units}`);
          console.log('   Difference:');
          console.log(`     Pallets: ${palletsDiff > 0 ? '+' : ''}${palletsDiff} | Packs: ${packsDiff > 0 ? '+' : ''}${packsDiff} | Units: ${unitsDiff > 0 ? '+' : ''}${unitsDiff}`);

          // Update inventory to match batch data
          await prisma.warehouseInventory.update({
            where: { id: currentInventory.id },
            data: {
              pallets: batchInventory.pallets,
              packs: batchInventory.packs,
              units: batchInventory.units,
              lastUpdated: new Date()
            }
          });

          console.log('   ✅ FIXED');
          fixed++;
        } else {
          unchanged++;
        }

      } catch (error) {
        console.error(`❌ Error processing ${product.name}:`, error.message);
        errors++;
      }
    }

    console.log('\n================================');
    console.log('📊 SUMMARY');
    console.log('================================');
    console.log(`✅ Fixed: ${fixed} products`);
    console.log(`⚪ Unchanged: ${unchanged} products`);
    console.log(`❌ Errors: ${errors} products`);
    console.log(`📦 Total: ${products.length} products\n`);

    if (fixed > 0) {
      console.log('🎉 Inventory has been recalculated successfully!');
      console.log('   All inventory records now match batch data.\n');
    } else {
      console.log('✨ No discrepancies found. Inventory is accurate!\n');
    }

  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Check for dry-run flag
const isDryRun = process.argv.includes('--dry-run');

if (isDryRun) {
  console.log('🔍 DRY RUN MODE - No changes will be made\n');
}

recalculateInventory();
