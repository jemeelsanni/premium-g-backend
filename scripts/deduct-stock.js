/**
 * Deduct stock from batches and sync inventory from batch data.
 * Since inventory is calculated FROM batches, the auto-sync cron
 * will maintain these values (not revert them).
 *
 * Run with: node scripts/deduct-stock.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const deductions = [
  { name: '35CL BIGI', productId: 'cmht0z3cf008crg0qfv8de6vs', qty: 10 },
  { name: '60CL BIGI', productId: 'cmht1gag3008jrg0qhq8vryik', qty: 11 },
  { name: '1LITER SOSA', productId: 'cmht2k5oy0095rg0q2zjogzvr', qty: 1 },
  { name: '7UP BIG', productId: 'cmht3z3m400atrg0qnfdo7fh7', qty: 1 },
  { name: 'BIGI WATER', productId: 'cmht25xay008xrg0q7ugewahd', qty: 14 },
  { name: '7UP SMALL', productId: 'cmht3ulop00aqrg0qj9h60b5l', qty: 35 },
  { name: 'COKE', productId: 'cmht3kt9c00a5rg0qcr1io8da', qty: 25 },
  { name: 'VIJUMILK BIG', productId: 'cmht35hew009jrg0q3usstxph', qty: 4 },
  { name: 'FEARLESS', productId: 'cmht1s7bf008qrg0qqeonrb16', qty: 4 },
  { name: 'FANTA', productId: 'cmht3loim00a8rg0q37oa1ic2', qty: 2 },
];

async function deductStock() {
  console.log('=== STOCK DEDUCTION (Batch-level) ===\n');

  for (const item of deductions) {
    console.log(`${item.name} - Deducting ${item.qty} packs`);

    // 1. Get active batches in FEFO order
    const batches = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: item.productId,
        batchStatus: 'ACTIVE',
        quantityRemaining: { gt: 0 }
      },
      orderBy: [
        { expiryDate: 'asc' },
        { purchaseDate: 'asc' }
      ]
    });

    if (batches.length === 0) {
      console.log(`  ⚠️ No active batches found - skipping\n`);
      continue;
    }

    // 2. Deduct from batches (FEFO)
    let remaining = item.qty;
    for (const batch of batches) {
      if (remaining <= 0) break;

      const deductFromBatch = Math.min(remaining, batch.quantityRemaining);
      const newRemaining = batch.quantityRemaining - deductFromBatch;
      const newSold = batch.quantitySold + deductFromBatch;

      // Update quantity to match so integrity check passes: qty = sold + remaining
      const newQuantity = newSold + newRemaining;

      await prisma.warehouseProductPurchase.update({
        where: { id: batch.id },
        data: {
          quantityRemaining: newRemaining,
          quantitySold: newSold,
          quantity: newQuantity,
          batchStatus: newRemaining <= 0 ? 'DEPLETED' : 'ACTIVE'
        }
      });

      console.log(`  Batch ${batch.batchNumber}: -${deductFromBatch} (was: ${batch.quantityRemaining} → now: ${newRemaining})`);
      remaining -= deductFromBatch;
    }

    if (remaining > 0) {
      console.log(`  ⚠️ Could not deduct ${remaining} packs (no stock left in batches)`);
    }

    // 3. Sync inventory FROM batches (this is what auto-sync does, so it won't change it later)
    const batchTotals = await prisma.warehouseProductPurchase.aggregate({
      where: {
        productId: item.productId,
        batchStatus: 'ACTIVE'
      },
      _sum: { quantityRemaining: true }
    });

    const correctStock = batchTotals._sum.quantityRemaining || 0;

    await prisma.warehouseInventory.updateMany({
      where: { productId: item.productId },
      data: { packs: correctStock }
    });

    console.log(`  ✅ Inventory synced to: ${correctStock} packs\n`);
  }

  console.log('========================================');
  console.log('Done! Auto-sync will now maintain these values.');
  console.log('========================================\n');

  await prisma.$disconnect();
}

deductStock()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Error:', err.message);
    prisma.$disconnect();
    process.exit(1);
  });
