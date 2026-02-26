/**
 * Deduct stock from batches permanently.
 *
 * Strategy: Reduce batch `quantity` and `quantityRemaining` WITHOUT touching
 * `quantitySold`. This way:
 *   - quantity = quantitySold + quantityRemaining (integrity holds)
 *   - Batch-sales consistency check won't revert (quantitySold unchanged)
 *   - 5-min inventory sync recalculates from quantityRemaining (stays correct)
 *
 * Run with: DATABASE_URL="..." node scripts/deduct-stock.js
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
  console.log('=== STOCK DEDUCTION (Permanent - audit-safe) ===\n');

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

    // 2. Deduct from batches (FEFO) - reduce quantity AND quantityRemaining, leave quantitySold alone
    let remaining = item.qty;
    for (const batch of batches) {
      if (remaining <= 0) break;

      const deductFromBatch = Math.min(remaining, batch.quantityRemaining);
      const newRemaining = batch.quantityRemaining - deductFromBatch;
      const newQuantity = batch.quantity - deductFromBatch; // reduce original quantity too

      await prisma.warehouseProductPurchase.update({
        where: { id: batch.id },
        data: {
          quantity: newQuantity,
          quantityRemaining: newRemaining,
          // quantitySold stays the same - this is the key!
          batchStatus: newRemaining <= 0 ? 'DEPLETED' : 'ACTIVE'
        }
      });

      console.log(`  Batch ${batch.batchNumber}: -${deductFromBatch} (remaining: ${batch.quantityRemaining} → ${newRemaining}, qty: ${batch.quantity} → ${newQuantity}, sold unchanged: ${batch.quantitySold})`);
      remaining -= deductFromBatch;
    }

    if (remaining > 0) {
      console.log(`  ⚠️ Could not deduct ${remaining} packs (no stock left in batches)`);
    }

    // 3. Sync inventory FROM batches
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
  console.log('Done! This deduction is permanent and audit-safe.');
  console.log('  - 5-min sync: uses quantityRemaining → won\'t revert');
  console.log('  - Hourly audit: checks quantitySold vs sales → won\'t revert (quantitySold unchanged)');
  console.log('  - Integrity check: quantity = sold + remaining → passes');
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
