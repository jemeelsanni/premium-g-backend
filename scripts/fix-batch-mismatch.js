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
        let newQuantityRemaining = batch.quantity - trackedSales;
        let newQuantity = batch.quantity;

        // If tracked sales exceed batch quantity, we need to increase the batch quantity
        // This ensures the integrity check passes: quantityRemaining + quantitySold = quantity
        if (newQuantityRemaining < 0) {
          console.log(`  ⚠️  Tracked sales (${trackedSales}) exceed batch quantity (${batch.quantity})`);
          console.log(`  ⚠️  Adjusting batch quantity to match actual sales...`);
          newQuantity = trackedSales; // Increase quantity to match sales
          newQuantityRemaining = 0;   // Nothing remaining
        }

        await prisma.warehouseProductPurchase.update({
          where: { id: batch.id },
          data: {
            quantity: newQuantity,
            quantitySold: trackedSales,
            quantityRemaining: newQuantityRemaining,
            batchStatus: newQuantityRemaining <= 0 ? 'DEPLETED' : 'ACTIVE'
          }
        });

        console.log(`  ✅ Fixed: quantity=${newQuantity}, quantitySold=${trackedSales}, quantityRemaining=${newQuantityRemaining}`);
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

    // ================================================================
    // INTEGRITY FIX: Find batches where quantity != sold + remaining
    // ================================================================
    console.log('Checking for integrity violations...\n');

    const integrityViolations = await prisma.$queryRaw`
      SELECT
        id,
        batch_number,
        quantity,
        quantity_sold,
        quantity_remaining,
        product_id
      FROM warehouse_product_purchases
      WHERE quantity_remaining < 0
        OR quantity_sold < 0
        OR quantity_remaining + quantity_sold != quantity
    `;

    if (integrityViolations.length > 0) {
      console.log(`Found ${integrityViolations.length} integrity violation(s). Fixing...\n`);

      for (const batch of integrityViolations) {
        const product = await prisma.product.findUnique({
          where: { id: batch.product_id },
          select: { name: true }
        });

        console.log(`Batch: ${batch.batch_number}`);
        console.log(`  Product: ${product?.name}`);
        console.log(`  quantity: ${batch.quantity}`);
        console.log(`  quantitySold: ${batch.quantity_sold}`);
        console.log(`  quantityRemaining: ${batch.quantity_remaining}`);
        console.log(`  Sum: ${Number(batch.quantity_sold) + Number(batch.quantity_remaining)}`);

        // Fix: Set quantity = quantitySold + quantityRemaining (use tracked sales as source of truth)
        const trackedSales = await prisma.warehouseBatchSale.aggregate({
          where: { batchId: batch.id },
          _sum: { quantitySold: true }
        });
        const actualSold = trackedSales._sum.quantitySold || 0;

        // Calculate correct values
        let newQuantity = Math.max(batch.quantity, actualSold);
        let newRemaining = newQuantity - actualSold;

        await prisma.warehouseProductPurchase.update({
          where: { id: batch.id },
          data: {
            quantity: newQuantity,
            quantitySold: actualSold,
            quantityRemaining: newRemaining,
            batchStatus: newRemaining <= 0 ? 'DEPLETED' : 'ACTIVE'
          }
        });

        console.log(`  ✅ Fixed: quantity=${newQuantity}, sold=${actualSold}, remaining=${newRemaining}\n`);
      }
    } else {
      console.log('No integrity violations found.\n');
    }

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
