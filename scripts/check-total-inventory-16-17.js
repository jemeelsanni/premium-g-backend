const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('\n📊 TOTAL WAREHOUSE INVENTORY - DEC 16 vs DEC 17\n');
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

    console.log('\nTotal Products: ' + products.length);

    // Dec 16 transactions
    const dec16Start = new Date('2024-12-16T00:00:00Z');
    const dec16End = new Date('2024-12-16T23:59:59Z');

    // Dec 17 transactions
    const dec17Start = new Date('2024-12-17T00:00:00Z');
    const dec17End = new Date('2024-12-17T23:59:59Z');

    // Calculate for each product
    let totalCurrentInventory = 0;
    let totalDec16Closing = 0;
    const discrepancies = [];

    for (const product of products) {
      const inv = product.warehouseInventory[0];
      if (!inv) continue;

      const currentPacks = inv.packs || 0;
      totalCurrentInventory += currentPacks;

      // Get Dec 16 purchases
      const dec16Purchases = await prisma.warehouseProductPurchase.aggregate({
        where: {
          productId: product.id,
          purchaseDate: { gte: dec16Start, lte: dec16End },
          unitType: 'PACKS'
        },
        _sum: { quantity: true }
      });

      // Get Dec 16 sales
      const dec16Sales = await prisma.warehouseSale.aggregate({
        where: {
          productId: product.id,
          createdAt: { gte: dec16Start, lte: dec16End },
          unitType: 'PACKS'
        },
        _sum: { quantity: true }
      });

      // Get Dec 17 purchases
      const dec17Purchases = await prisma.warehouseProductPurchase.aggregate({
        where: {
          productId: product.id,
          purchaseDate: { gte: dec17Start, lte: dec17End },
          unitType: 'PACKS'
        },
        _sum: { quantity: true }
      });

      // Get Dec 17 sales
      const dec17Sales = await prisma.warehouseSale.aggregate({
        where: {
          productId: product.id,
          createdAt: { gte: dec17Start, lte: dec17End },
          unitType: 'PACKS'
        },
        _sum: { quantity: true }
      });

      // Calculate Dec 16 closing
      const dec16NetChange = (dec16Purchases._sum.quantity || 0) - (dec16Sales._sum.quantity || 0);
      const dec17NetChange = (dec17Purchases._sum.quantity || 0) - (dec17Sales._sum.quantity || 0);

      // Dec 16 closing = Current inventory - Dec 17 net change
      const dec16Closing = currentPacks - dec17NetChange;
      totalDec16Closing += dec16Closing;

      // Check if there's a discrepancy between current and expected
      const dec17Opening = dec16Closing; // Should be same
      const dec17Closing = currentPacks;

      if (dec17NetChange !== 0 || (dec16Purchases._sum.quantity || 0) > 0 || (dec16Sales._sum.quantity || 0) > 0) {
        discrepancies.push({
          product: product.name,
          dec16Purchases: dec16Purchases._sum.quantity || 0,
          dec16Sales: dec16Sales._sum.quantity || 0,
          dec16NetChange,
          dec16Closing,
          dec17Purchases: dec17Purchases._sum.quantity || 0,
          dec17Sales: dec17Sales._sum.quantity || 0,
          dec17NetChange,
          dec17Opening,
          currentInventory: currentPacks,
          match: dec17Closing === dec17Opening + dec17NetChange
        });
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('TOTALS:');
    console.log('  Dec 16 Calculated Closing: ' + totalDec16Closing + ' packs');
    console.log('  Dec 17 Opening (current): ' + totalCurrentInventory + ' packs');
    console.log('  Discrepancy: ' + (totalCurrentInventory - totalDec16Closing) + ' packs');
    console.log('='.repeat(80));

    if (discrepancies.length > 0) {
      console.log('\nProducts with Dec 16-17 Activity:');
      console.log('');
      discrepancies.forEach(d => {
        console.log('📦 ' + d.product);
        console.log('  Dec 16:');
        if (d.dec16Purchases > 0) console.log('    + Purchases: ' + d.dec16Purchases + ' packs');
        if (d.dec16Sales > 0) console.log('    - Sales: ' + d.dec16Sales + ' packs');
        console.log('    = Closing: ' + d.dec16Closing + ' packs');
        console.log('  Dec 17:');
        if (d.dec17Purchases > 0) console.log('    + Purchases: ' + d.dec17Purchases + ' packs');
        if (d.dec17Sales > 0) console.log('    - Sales: ' + d.dec17Sales + ' packs');
        console.log('    = Current: ' + d.currentInventory + ' packs');
        console.log('');
      });
    }

    // Find the exact discrepancy
    console.log('='.repeat(80));
    console.log('INVESTIGATING 16-PACK DISCREPANCY...\n');

    const allProducts = await prisma.product.findMany({
      where: {
        warehouseInventory: { some: {} }
      },
      include: {
        warehouseInventory: true
      }
    });

    const productDiscrepancies = [];

    for (const product of allProducts) {
      const inv = product.warehouseInventory[0];
      if (!inv) continue;

      // Get all batches
      const batches = await prisma.warehouseProductPurchase.aggregate({
        where: {
          productId: product.id,
          batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
          unitType: 'PACKS'
        },
        _sum: {
          quantity: true,
          quantitySold: true,
          quantityRemaining: true
        }
      });

      // Get all sales
      const sales = await prisma.warehouseSale.aggregate({
        where: {
          productId: product.id,
          unitType: 'PACKS'
        },
        _sum: { quantity: true }
      });

      const totalPurchased = batches._sum.quantity || 0;
      const totalSold = sales._sum.quantity || 0;
      const batchRemaining = batches._sum.quantityRemaining || 0;
      const expectedRemaining = totalPurchased - totalSold;
      const diff = batchRemaining - expectedRemaining;

      if (diff !== 0) {
        productDiscrepancies.push({
          product: product.name,
          totalPurchased,
          totalSold,
          batchRemaining,
          expectedRemaining,
          discrepancy: diff
        });
      }
    }

    if (productDiscrepancies.length > 0) {
      console.log('Products with Batch/Sales Discrepancies:');
      productDiscrepancies.forEach(p => {
        console.log('');
        console.log('  ' + p.product + ':');
        console.log('    Purchased: ' + p.totalPurchased + ' packs');
        console.log('    Sold: ' + p.totalSold + ' packs');
        console.log('    Expected: ' + p.expectedRemaining + ' packs');
        console.log('    Actual: ' + p.batchRemaining + ' packs');
        console.log('    Discrepancy: ' + (p.discrepancy > 0 ? '+' : '') + p.discrepancy + ' packs');
      });

      const totalDiscrepancy = productDiscrepancies.reduce((sum, p) => sum + p.discrepancy, 0);
      console.log('\n  Total Discrepancy: ' + totalDiscrepancy + ' packs');
    } else {
      console.log('✅ No batch/sales discrepancies found!');
    }

    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
