/**
 * Script to fix batch-sales mismatch in warehouse
 * Run with: node scripts/fix-batch-mismatch.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixBatchMismatch() {
  console.log('Checking for batch-sales mismatches...\n');

  try {
    // Get all batches
    const batches = await prisma.warehouseProductPurchase.findMany({
      select: {
        id: true,
        batchNumber: true,
        quantity: true,
        quantitySold: true,
        quantityRemaining: true,
        productId: true,
        product: {
          select: { name: true }
        }
      }
    });

    console.log(`Found ${batches.length} batch(es)\n`);

    if (batches.length === 0) {
      console.log('No batches exist in the database.');
      console.log('You need to create inventory purchases before making sales.');
      return;
    }

    let fixedCount = 0;

    for (const batch of batches) {
      // Get sum of tracked sales for this batch
      const salesSum = await prisma.warehouseBatchSale.aggregate({
        where: { batchId: batch.id },
        _sum: { quantitySold: true }
      });

      const trackedSales = salesSum._sum.quantitySold || 0;

      console.log(`Batch: ${batch.batchNumber || batch.id.slice(-8)}`);
      console.log(`  Product: ${batch.product.name}`);
      console.log(`  Total Qty: ${batch.quantity}`);
      console.log(`  Qty Sold (batch): ${batch.quantitySold}`);
      console.log(`  Qty Sold (tracked): ${trackedSales}`);
      console.log(`  Qty Remaining: ${batch.quantityRemaining}`);

      if (batch.quantitySold !== trackedSales) {
        console.log(`  ⚠️  MISMATCH DETECTED - Fixing...`);

        // Fix the mismatch by aligning quantitySold with tracked sales
        const newQuantityRemaining = batch.quantity - trackedSales;

        await prisma.warehouseProductPurchase.update({
          where: { id: batch.id },
          data: {
            quantitySold: trackedSales,
            quantityRemaining: Math.max(0, newQuantityRemaining),
            batchStatus: newQuantityRemaining <= 0 ? 'DEPLETED' : 'ACTIVE'
          }
        });

        console.log(`  ✅ Fixed: quantitySold=${trackedSales}, quantityRemaining=${newQuantityRemaining}`);
        fixedCount++;
      } else {
        console.log(`  ✅ OK`);
      }
      console.log('');
    }

    console.log('========================================');
    console.log(`Total batches checked: ${batches.length}`);
    console.log(`Batches fixed: ${fixedCount}`);
    console.log('========================================\n');

    // Also sync inventory for all products
    console.log('Syncing inventory from batches...\n');

    const products = await prisma.product.findMany({
      where: { module: { in: ['WAREHOUSE', 'BOTH'] } },
      select: { id: true, name: true }
    });

    for (const product of products) {
      const batchTotals = await prisma.warehouseProductPurchase.aggregate({
        where: {
          productId: product.id,
          batchStatus: 'ACTIVE'
        },
        _sum: { quantityRemaining: true }
      });

      const totalStock = batchTotals._sum.quantityRemaining || 0;

      await prisma.warehouseInventory.upsert({
        where: {
          productId_location: {
            productId: product.id,
            location: 'main'
          }
        },
        update: {
          packs: totalStock,
          units: 0,
          pallets: 0
        },
        create: {
          productId: product.id,
          location: 'main',
          packs: totalStock,
          units: 0,
          pallets: 0
        }
      });

      console.log(`${product.name}: ${totalStock} packs in stock`);
    }

    console.log('\n✅ Inventory sync completed!');

  } catch (error) {
    console.error('Error:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

fixBatchMismatch()
  .then(() => {
    console.log('\nScript completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
