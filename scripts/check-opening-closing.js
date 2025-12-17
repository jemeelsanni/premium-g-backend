const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    // Get 35CL BIGI product
    const product = await prisma.warehouseProduct.findFirst({
      where: { name: { contains: '35CL BIGI' } }
    });

    if (!product) {
      console.log('❌ Product not found');
      return;
    }

    console.log('\n📊 OPENING/CLOSING STOCK ANALYSIS - 35CL BIGI\n');
    console.log('='.repeat(80));

    // Get daily opening stocks for Dec 16-17
    const openingStocks = await prisma.warehouseDailyOpeningStock.findMany({
      where: {
        productId: product.id,
        date: {
          gte: new Date('2024-12-16T00:00:00Z'),
          lte: new Date('2024-12-17T23:59:59Z')
        }
      },
      orderBy: { date: 'asc' }
    });

    console.log('\nDaily Opening Stocks:');
    openingStocks.forEach(stock => {
      const date = new Date(stock.date).toLocaleDateString('en-GB');
      console.log('  ' + date + ': ' + stock.packs + ' packs');
    });

    // Calculate Dec 16 closing (opening + purchases - sales)
    const dec16Start = new Date('2024-12-16T00:00:00Z');
    const dec16End = new Date('2024-12-16T23:59:59Z');

    // Dec 16 opening
    const dec16Opening = openingStocks.find(s =>
      new Date(s.date).toLocaleDateString('en-GB') === '16/12/2024'
    );

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

    const dec16Closing = (dec16Opening?.packs || 0) +
                         (dec16Purchases._sum.quantity || 0) -
                         (dec16Sales._sum.quantity || 0);

    console.log('\nDec 16 Calculations:');
    console.log('  Opening: ' + (dec16Opening?.packs || 0) + ' packs');
    console.log('  + Purchases: ' + (dec16Purchases._sum.quantity || 0) + ' packs');
    console.log('  - Sales: ' + (dec16Sales._sum.quantity || 0) + ' packs');
    console.log('  = Expected Closing: ' + dec16Closing + ' packs');

    // Dec 17 opening
    const dec17Opening = openingStocks.find(s =>
      new Date(s.date).toLocaleDateString('en-GB') === '17/12/2024'
    );

    console.log('\nDec 17 Opening: ' + (dec17Opening?.packs || 0) + ' packs');

    // Check discrepancy
    const discrepancy = dec16Closing - (dec17Opening?.packs || 0);
    console.log('\n' + '='.repeat(80));
    if (discrepancy !== 0) {
      console.log('❌ DISCREPANCY FOUND: ' + Math.abs(discrepancy) + ' packs ' +
                  (discrepancy > 0 ? 'missing' : 'excess'));
      console.log('   Dec 16 closing should be ' + dec16Closing +
                  ' but Dec 17 opening is ' + (dec17Opening?.packs || 0));
    } else {
      console.log('✅ NO DISCREPANCY: Dec 16 closing matches Dec 17 opening');
    }

    // Current inventory
    const currentInv = await prisma.warehouseInventory.findFirst({
      where: { productId: product.id }
    });

    console.log('\nCurrent Inventory: ' + (currentInv?.packs || 0) + ' packs');

    // Calculate from batches
    const batches = await prisma.warehouseProductPurchase.aggregate({
      where: {
        productId: product.id,
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
        unitType: 'PACKS'
      },
      _sum: { quantityRemaining: true }
    });

    console.log('Batch Total: ' + (batches._sum.quantityRemaining || 0) + ' packs');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
