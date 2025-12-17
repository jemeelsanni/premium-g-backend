const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('\n📊 DEC 16 CLOSING vs DEC 17 OPENING - EXACT CALCULATION\n');
    console.log('='.repeat(80));

    // Get all products with inventory
    const products = await prisma.product.findMany({
      where: {
        warehouseInventory: { some: {} }
      },
      include: {
        warehouseInventory: true
      }
    });

    console.log('Total Products: ' + products.length + '\n');

    // Define date ranges
    const dec16Start = new Date('2024-12-16T00:00:00Z');
    const dec16End = new Date('2024-12-16T23:59:59.999Z');
    const dec17Start = new Date('2024-12-17T00:00:00Z');
    const dec17End = new Date('2024-12-17T23:59:59.999Z');

    let totalCurrentInventory = 0;
    let totalDec16Closing = 0;
    let totalDec17Opening = 0;

    const productDetails = [];

    for (const product of products) {
      const inv = product.warehouseInventory[0];
      if (!inv) continue;

      // Current inventory (as of now)
      const currentPacks = inv.packs || 0;
      totalCurrentInventory += currentPacks;

      // Dec 16 purchases
      const dec16Purchases = await prisma.warehouseProductPurchase.aggregate({
        where: {
          productId: product.id,
          purchaseDate: { gte: dec16Start, lte: dec16End },
          unitType: 'PACKS'
        },
        _sum: { quantity: true }
      });

      // Dec 16 sales
      const dec16Sales = await prisma.warehouseSale.aggregate({
        where: {
          productId: product.id,
          createdAt: { gte: dec16Start, lte: dec16End },
          unitType: 'PACKS'
        },
        _sum: { quantity: true }
      });

      // Dec 17 purchases
      const dec17Purchases = await prisma.warehouseProductPurchase.aggregate({
        where: {
          productId: product.id,
          purchaseDate: { gte: dec17Start, lte: dec17End },
          unitType: 'PACKS'
        },
        _sum: { quantity: true }
      });

      // Dec 17 sales
      const dec17Sales = await prisma.warehouseSale.aggregate({
        where: {
          productId: product.id,
          createdAt: { gte: dec17Start, lte: dec17End },
          unitType: 'PACKS'
        },
        _sum: { quantity: true }
      });

      const dec16NetChange = (dec16Purchases._sum.quantity || 0) - (dec16Sales._sum.quantity || 0);
      const dec17NetChange = (dec17Purchases._sum.quantity || 0) - (dec17Sales._sum.quantity || 0);

      // Dec 16 closing = Current - Dec 17 net change
      const dec16Closing = currentPacks - dec17NetChange;
      totalDec16Closing += dec16Closing;

      // Dec 17 opening should equal Dec 16 closing
      const dec17Opening = dec16Closing;
      totalDec17Opening += dec17Opening;

      if (dec16NetChange !== 0 || dec17NetChange !== 0) {
        productDetails.push({
          product: product.name,
          dec16Purchases: dec16Purchases._sum.quantity || 0,
          dec16Sales: dec16Sales._sum.quantity || 0,
          dec16NetChange,
          dec16Closing,
          dec17Purchases: dec17Purchases._sum.quantity || 0,
          dec17Sales: dec17Sales._sum.quantity || 0,
          dec17NetChange,
          dec17Opening,
          currentInventory: currentPacks
        });
      }
    }

    console.log('='.repeat(80));
    console.log('TOTALS:');
    console.log('  Dec 16 Closing Stock: ' + totalDec16Closing + ' packs');
    console.log('  Dec 17 Opening Stock: ' + totalDec17Opening + ' packs');
    console.log('  Current Inventory: ' + totalCurrentInventory + ' packs');
    console.log('  Discrepancy (16 close vs 17 open): ' + (totalDec17Opening - totalDec16Closing) + ' packs');
    console.log('='.repeat(80));

    if (productDetails.length > 0) {
      console.log('\nProducts with Activity on Dec 16-17:\n');
      productDetails.forEach(d => {
        console.log('📦 ' + d.product);
        console.log('  Dec 16:');
        if (d.dec16Purchases > 0) console.log('    Purchases: +' + d.dec16Purchases);
        if (d.dec16Sales > 0) console.log('    Sales: -' + d.dec16Sales);
        console.log('    Closing: ' + d.dec16Closing + ' packs');
        console.log('  Dec 17:');
        console.log('    Opening: ' + d.dec17Opening + ' packs');
        if (d.dec17Purchases > 0) console.log('    Purchases: +' + d.dec17Purchases);
        if (d.dec17Sales > 0) console.log('    Sales: -' + d.dec17Sales);
        console.log('    Current: ' + d.currentInventory + ' packs');
        console.log('');
      });
    }

    // Now check actual batch data for Dec 16 end of day
    console.log('='.repeat(80));
    console.log('VERIFICATION USING BATCH DATA:\n');

    // Get all batches as of end of Dec 16 (simulate)
    const allBatchesDec16 = await prisma.warehouseProductPurchase.findMany({
      where: {
        purchaseDate: { lte: dec16End },
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
        unitType: 'PACKS'
      }
    });

    // Get all sales up to end of Dec 16
    const allSalesDec16 = await prisma.warehouseSale.aggregate({
      where: {
        createdAt: { lte: dec16End },
        unitType: 'PACKS'
      },
      _sum: { quantity: true }
    });

    const totalPurchasedByDec16 = allBatchesDec16.reduce((sum, b) => sum + b.quantity, 0);
    const totalSoldByDec16 = allSalesDec16._sum.quantity || 0;
    const expectedDec16Closing = totalPurchasedByDec16 - totalSoldByDec16;

    console.log('  Total Purchased (by Dec 16): ' + totalPurchasedByDec16 + ' packs');
    console.log('  Total Sold (by Dec 16): ' + totalSoldByDec16 + ' packs');
    console.log('  Expected Dec 16 Closing: ' + expectedDec16Closing + ' packs');
    console.log('  Calculated Dec 16 Closing: ' + totalDec16Closing + ' packs');
    console.log('  Difference: ' + (totalDec16Closing - expectedDec16Closing) + ' packs');

    console.log('\n' + '='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
