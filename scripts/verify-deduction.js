const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const products = [
  { name: '35CL BIGI', id: 'cmht0z3cf008crg0qfv8de6vs' },
  { name: '60CL BIGI', id: 'cmht1gag3008jrg0qhq8vryik' },
  { name: '1LITER SOSA', id: 'cmht2k5oy0095rg0q2zjogzvr' },
  { name: '7UP BIG', id: 'cmht3z3m400atrg0qnfdo7fh7' },
  { name: 'BIGI WATER', id: 'cmht25xay008xrg0q7ugewahd' },
  { name: '7UP SMALL', id: 'cmht3ulop00aqrg0qj9h60b5l' },
  { name: 'COKE', id: 'cmht3kt9c00a5rg0qcr1io8da' },
  { name: 'VIJUMILK BIG', id: 'cmht35hew009jrg0q3usstxph' },
  { name: 'FEARLESS', id: 'cmht1s7bf008qrg0qqeonrb16' },
  { name: 'FANTA', id: 'cmht3loim00a8rg0q37oa1ic2' },
];

async function verify() {
  console.log('=== DEDUCTION VERIFICATION ===\n');
  let allGood = true;

  for (const p of products) {
    const batches = await prisma.warehouseProductPurchase.findMany({
      where: { productId: p.id, batchStatus: { in: ['ACTIVE', 'DEPLETED'] } },
      select: { batchNumber: true, quantity: true, quantitySold: true, quantityRemaining: true }
    });

    // Check 1: quantity = sold + remaining for each batch
    let integrityOk = true;
    for (const b of batches) {
      const expected = b.quantitySold + b.quantityRemaining;
      if (b.quantity !== expected) {
        console.log('  FAIL integrity: ' + p.name + ' batch ' + b.batchNumber +
          ' qty=' + b.quantity + ' sold=' + b.quantitySold + ' rem=' + b.quantityRemaining +
          ' (expected qty=' + expected + ')');
        integrityOk = false;
        allGood = false;
      }
    }

    // Check 2: total quantitySold matches actual warehouseSale records
    const batchSoldTotal = batches.reduce((s, b) => s + b.quantitySold, 0);
    const actualSales = await prisma.warehouseSale.aggregate({
      where: { productId: p.id },
      _sum: { quantity: true }
    });
    const salesTotal = actualSales._sum.quantity || 0;
    const salesMatch = (batchSoldTotal === salesTotal);

    // Check 3: inventory packs matches sum of batch quantityRemaining
    const inv = await prisma.warehouseInventory.findFirst({
      where: { productId: p.id },
      select: { packs: true }
    });
    const batchRemTotal = batches.reduce((s, b) => s + b.quantityRemaining, 0);
    const invMatch = ((inv ? inv.packs : 0) === batchRemTotal);

    const line = p.name + ': integrity=' + (integrityOk ? 'OK' : 'FAIL') +
      ' | salesMatch=' + salesMatch +
      (salesMatch ? '' : ' (batchSold=' + batchSoldTotal + ' actualSales=' + salesTotal + ')') +
      ' | invMatch=' + invMatch +
      (invMatch ? '' : ' (inv=' + (inv ? inv.packs : 0) + ' batchRem=' + batchRemTotal + ')');

    console.log(line);
    if (!salesMatch || !invMatch) allGood = false;
  }

  console.log('\n=== RESULT: ' + (allGood ? 'ALL CHECKS PASSED - DEDUCTION IS SAFE' : 'SOME ISSUES FOUND') + ' ===');

  // Simulate what the hourly audit would do
  console.log('\n=== SIMULATING HOURLY AUDIT (fixBatchSalesDiscrepancy) ===\n');
  for (const p of products) {
    const batchSold = await prisma.warehouseProductPurchase.aggregate({
      where: { productId: p.id },
      _sum: { quantitySold: true }
    });
    const actualSales = await prisma.warehouseSale.aggregate({
      where: { productId: p.id },
      _sum: { quantity: true }
    });
    const batchTotal = batchSold._sum.quantitySold || 0;
    const salesTotal = actualSales._sum.quantity || 0;
    const wouldRevert = (batchTotal !== salesTotal);
    console.log(p.name + ': batchSold=' + batchTotal + ' actualSales=' + salesTotal +
      ' → ' + (wouldRevert ? 'WOULD REVERT!' : 'Safe (no action)'));
  }

  await prisma.$disconnect();
}

verify().catch(err => { console.error(err); prisma.$disconnect(); process.exit(1); });
