const { PrismaClient } = require('@prisma/client');
const { createAuditLog } = require('../utils/auditLogger');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('\n🔧 FIXING ORPHANED BATCH DEDUCTIONS\n');
    console.log('='.repeat(80));
    console.log('\nOrphaned batch deductions occur when sales are deleted but');
    console.log('batch quantitySold is not restored (historical bug).\n');
    console.log('='.repeat(80));

    // Get all products
    const products = await prisma.product.findMany({
      where: {
        warehouseInventory: { some: {} }
      },
      include: {
        warehouseInventory: true
      }
    });

    let fixed = 0;
    let failed = 0;
    const fixedProducts = [];

    for (const product of products) {
      const inv = product.warehouseInventory[0];
      if (!inv) continue;

      // Get all batches
      const batches = await prisma.warehouseProductPurchase.findMany({
        where: {
          productId: product.id,
          batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
          unitType: 'PACKS'
        }
      });

      if (batches.length === 0) continue;

      // Get batch sales total
      const batchSalesTotal = await prisma.warehouseBatchSale.aggregate({
        where: {
          sale: {
            productId: product.id,
            unitType: 'PACKS'
          }
        },
        _sum: { quantitySold: true }
      });

      const totalBatchSalesLinked = batchSalesTotal._sum.quantitySold || 0;
      const totalSoldFromBatches = batches.reduce((sum, b) => sum + b.quantitySold, 0);
      const discrepancy = totalSoldFromBatches - totalBatchSalesLinked;

      if (discrepancy !== 0) {
        console.log('\n📦 ' + product.name);
        console.log('  Batch quantitySold: ' + totalSoldFromBatches + ' packs');
        console.log('  BatchSales linked: ' + totalBatchSalesLinked + ' packs');
        console.log('  Discrepancy: ' + discrepancy + ' packs');

        try {
          // We need to adjust batches to match the actual linked sales
          // Strategy: Distribute the discrepancy across batches proportionally

          if (discrepancy > 0) {
            // Batches show MORE sold than actual → reduce quantitySold, increase quantityRemaining
            console.log('  Fixing: Reducing quantitySold by ' + discrepancy + ' packs...');

            // Find batches with quantitySold > 0 to adjust
            const batchesToAdjust = batches.filter(b => b.quantitySold > 0);

            if (batchesToAdjust.length === 0) {
              console.log('  ❌ No batches with quantitySold to adjust');
              failed++;
              continue;
            }

            // Adjust oldest batch first (FIFO principle)
            batchesToAdjust.sort((a, b) =>
              new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime()
            );

            let remaining = discrepancy;

            for (const batch of batchesToAdjust) {
              if (remaining <= 0) break;

              const adjustAmount = Math.min(remaining, batch.quantitySold);

              const updatedBatch = await prisma.warehouseProductPurchase.update({
                where: { id: batch.id },
                data: {
                  quantitySold: { decrement: adjustAmount },
                  quantityRemaining: { increment: adjustAmount },
                  batchStatus: 'ACTIVE'
                }
              });

              console.log('    - Batch ' + batch.batchNumber + ': -' + adjustAmount +
                          ' from quantitySold, +' + adjustAmount + ' to quantityRemaining');

              remaining -= adjustAmount;

              // Create audit log
              await createAuditLog({
                userId: null,
                action: 'UPDATE',
                entity: 'WarehouseProductPurchase',
                entityId: batch.id,
                oldValues: {
                  batchNumber: batch.batchNumber,
                  quantitySold: batch.quantitySold,
                  quantityRemaining: batch.quantityRemaining
                },
                newValues: {
                  batchNumber: updatedBatch.batchNumber,
                  quantitySold: updatedBatch.quantitySold,
                  quantityRemaining: updatedBatch.quantityRemaining
                },
                metadata: {
                  triggeredBy: 'ORPHANED_BATCH_CORRECTION',
                  scriptName: 'fix-orphaned-batch-deductions.js',
                  productId: product.id,
                  productName: product.name,
                  reason: 'Fixing orphaned batch deductions from historical delete sale bug',
                  adjustmentAmount: adjustAmount
                }
              });
            }

          } else {
            // Batches show LESS sold than actual → increase quantitySold, decrease quantityRemaining
            const absDiscrepancy = Math.abs(discrepancy);
            console.log('  Fixing: Increasing quantitySold by ' + absDiscrepancy + ' packs...');

            // Find batches with quantityRemaining > 0
            const batchesToAdjust = batches.filter(b => b.quantityRemaining > 0);

            if (batchesToAdjust.length === 0) {
              console.log('  ❌ No batches with quantityRemaining to adjust');
              failed++;
              continue;
            }

            batchesToAdjust.sort((a, b) =>
              new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime()
            );

            let remaining = absDiscrepancy;

            for (const batch of batchesToAdjust) {
              if (remaining <= 0) break;

              const adjustAmount = Math.min(remaining, batch.quantityRemaining);

              const updatedBatch = await prisma.warehouseProductPurchase.update({
                where: { id: batch.id },
                data: {
                  quantitySold: { increment: adjustAmount },
                  quantityRemaining: { decrement: adjustAmount }
                }
              });

              console.log('    - Batch ' + batch.batchNumber + ': +' + adjustAmount +
                          ' to quantitySold, -' + adjustAmount + ' from quantityRemaining');

              remaining -= adjustAmount;

              await createAuditLog({
                userId: null,
                action: 'UPDATE',
                entity: 'WarehouseProductPurchase',
                entityId: batch.id,
                oldValues: {
                  batchNumber: batch.batchNumber,
                  quantitySold: batch.quantitySold,
                  quantityRemaining: batch.quantityRemaining
                },
                newValues: {
                  batchNumber: updatedBatch.batchNumber,
                  quantitySold: updatedBatch.quantitySold,
                  quantityRemaining: updatedBatch.quantityRemaining
                },
                metadata: {
                  triggeredBy: 'ORPHANED_BATCH_CORRECTION',
                  scriptName: 'fix-orphaned-batch-deductions.js',
                  productId: product.id,
                  productName: product.name,
                  reason: 'Fixing orphaned batch deductions from historical delete sale bug',
                  adjustmentAmount: adjustAmount
                }
              });
            }
          }

          // Sync inventory from batches
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

          console.log('  ✅ Fixed! Inventory synced to: ' + calculatedInventory.packs + ' packs');

          fixedProducts.push({
            product: product.name,
            discrepancy,
            newInventory: calculatedInventory.packs
          });

          fixed++;

        } catch (error) {
          console.log('  ❌ Error: ' + error.message);
          failed++;
        }
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('📊 SUMMARY');
    console.log('='.repeat(80));
    console.log('Products Fixed: ' + fixed);
    console.log('Failed: ' + failed);
    console.log('');

    if (fixedProducts.length > 0) {
      console.log('Fixed Products:');
      fixedProducts.forEach(p => {
        console.log('  - ' + p.product + ': ' + (p.discrepancy > 0 ? '-' : '+') +
                    Math.abs(p.discrepancy) + ' packs → ' + p.newInventory + ' packs');
      });
    }

    console.log('\n✅ Orphaned batch deductions fixed!');
    console.log('   All audit logs created.\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
