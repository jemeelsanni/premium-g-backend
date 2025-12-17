const { PrismaClient } = require('@prisma/client');
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

    console.log('\n📊 RECENT HISTORY - 35CL BIGI\n');
    console.log('='.repeat(80));

    // Get last 10 sales
    const recentSales = await prisma.warehouseSale.findMany({
      where: {
        productId: product.id,
        unitType: 'PACKS'
      },
      include: {
        warehouseCustomer: { select: { name: true } }
      },
      orderBy: { createdAt: 'desc' },
      take: 10
    });

    console.log('\nLast 10 Sales:');
    recentSales.forEach((s, i) => {
      const date = new Date(s.createdAt).toLocaleString('en-GB');
      const customer = s.warehouseCustomer?.name || 'Walk-in';
      console.log(`  ${i + 1}. ${date} - ${s.quantity} packs to ${customer} (${s.receiptNumber})`);
    });

    // Get last 10 purchases
    const recentPurchases = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: product.id,
        unitType: 'PACKS'
      },
      orderBy: { purchaseDate: 'desc' },
      take: 10
    });

    console.log('\nLast 10 Purchases:');
    recentPurchases.forEach((p, i) => {
      const date = new Date(p.purchaseDate).toLocaleString('en-GB');
      console.log(`  ${i + 1}. ${date} - ${p.quantity} packs (Batch: ${p.batchNumber})`);
    });

    // Current inventory status
    const currentInv = await prisma.warehouseInventory.findFirst({
      where: { productId: product.id }
    });

    // Calculate from batches
    const batches = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: product.id,
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
        unitType: 'PACKS'
      },
      orderBy: { expiryDate: 'asc' }
    });

    console.log('\n' + '='.repeat(80));
    console.log('Current Inventory Status:');
    console.log('  Inventory Table: ' + (currentInv?.packs || 0) + ' packs');

    const batchTotal = batches.reduce((sum, b) => sum + b.quantityRemaining, 0);
    console.log('  Batch System: ' + batchTotal + ' packs');

    console.log('\nActive Batches:');
    batches.forEach(b => {
      if (b.quantityRemaining > 0) {
        const expiry = new Date(b.expiryDate).toLocaleDateString('en-GB');
        console.log(`  - Batch ${b.batchNumber}: ${b.quantityRemaining} packs (Exp: ${expiry})`);
      }
    });

    // Calculate all-time totals
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

    console.log('\n' + '='.repeat(80));
    console.log('All-Time Totals:');
    console.log('  Total Purchased: ' + (allPurchases._sum.quantity || 0) + ' packs');
    console.log('  Total Sold (from sales table): ' + (allSales._sum.quantity || 0) + ' packs');
    console.log('  Total Sold (from batches): ' + (allPurchases._sum.quantitySold || 0) + ' packs');
    console.log('  Total Remaining (from batches): ' + (allPurchases._sum.quantityRemaining || 0) + ' packs');

    const expectedRemaining = (allPurchases._sum.quantity || 0) - (allSales._sum.quantity || 0);
    console.log('  Expected Remaining: ' + expectedRemaining + ' packs');

    if (expectedRemaining === (allPurchases._sum.quantityRemaining || 0)) {
      console.log('  ✅ Batch system matches expected');
    } else {
      console.log('  ❌ DISCREPANCY in batch system');
    }
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
