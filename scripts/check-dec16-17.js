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

    console.log('\n📊 DEC 16-17 STOCK ANALYSIS - 35CL BIGI\n');
    console.log('='.repeat(80));

    // Dec 16 transactions
    const dec16Start = new Date('2024-12-16T00:00:00Z');
    const dec16End = new Date('2024-12-16T23:59:59Z');

    const dec16Purchases = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: product.id,
        purchaseDate: { gte: dec16Start, lte: dec16End },
        unitType: 'PACKS'
      }
    });

    const dec16Sales = await prisma.warehouseSale.findMany({
      where: {
        productId: product.id,
        createdAt: { gte: dec16Start, lte: dec16End },
        unitType: 'PACKS'
      },
      include: {
        warehouseCustomer: { select: { name: true } }
      }
    });

    console.log('\nDec 16 Transactions:');
    console.log('  Purchases: ' + dec16Purchases.length);
    dec16Purchases.forEach(p => {
      console.log('    - ' + p.quantity + ' packs purchased');
    });

    console.log('  Sales: ' + dec16Sales.length);
    dec16Sales.forEach(s => {
      const customer = s.warehouseCustomer?.name || 'Walk-in';
      console.log('    - ' + s.quantity + ' packs sold to ' + customer +
                  ' (' + s.receiptNumber + ')');
    });

    const dec16PurchasesTotal = dec16Purchases.reduce((sum, p) => sum + p.quantity, 0);
    const dec16SalesTotal = dec16Sales.reduce((sum, s) => sum + s.quantity, 0);

    console.log('\nDec 16 Summary:');
    console.log('  Total Purchases: ' + dec16PurchasesTotal + ' packs');
    console.log('  Total Sales: ' + dec16SalesTotal + ' packs');
    console.log('  Net Change: ' + (dec16PurchasesTotal - dec16SalesTotal) + ' packs');

    // Dec 17 transactions
    const dec17Start = new Date('2024-12-17T00:00:00Z');
    const dec17End = new Date('2024-12-17T23:59:59Z');

    const dec17Purchases = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: product.id,
        purchaseDate: { gte: dec17Start, lte: dec17End },
        unitType: 'PACKS'
      }
    });

    const dec17Sales = await prisma.warehouseSale.findMany({
      where: {
        productId: product.id,
        createdAt: { gte: dec17Start, lte: dec17End },
        unitType: 'PACKS'
      },
      include: {
        warehouseCustomer: { select: { name: true } }
      }
    });

    console.log('\nDec 17 Transactions:');
    console.log('  Purchases: ' + dec17Purchases.length);
    dec17Purchases.forEach(p => {
      console.log('    - ' + p.quantity + ' packs purchased');
    });

    console.log('  Sales: ' + dec17Sales.length);
    dec17Sales.forEach(s => {
      const customer = s.warehouseCustomer?.name || 'Walk-in';
      console.log('    - ' + s.quantity + ' packs sold to ' + customer +
                  ' (' + s.receiptNumber + ')');
    });

    const dec17PurchasesTotal = dec17Purchases.reduce((sum, p) => sum + p.quantity, 0);
    const dec17SalesTotal = dec17Sales.reduce((sum, s) => sum + s.quantity, 0);

    console.log('\nDec 17 Summary:');
    console.log('  Total Purchases: ' + dec17PurchasesTotal + ' packs');
    console.log('  Total Sales: ' + dec17SalesTotal + ' packs');
    console.log('  Net Change: ' + (dec17PurchasesTotal - dec17SalesTotal) + ' packs');

    // Current inventory
    const currentInv = await prisma.warehouseInventory.findFirst({
      where: { productId: product.id }
    });

    // Calculate from batches
    const batches = await prisma.warehouseProductPurchase.aggregate({
      where: {
        productId: product.id,
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
        unitType: 'PACKS'
      },
      _sum: { quantityRemaining: true }
    });

    console.log('\n' + '='.repeat(80));
    console.log('Current Status:');
    console.log('  Inventory Table: ' + (currentInv?.packs || 0) + ' packs');
    console.log('  Batch System: ' + (batches._sum.quantityRemaining || 0) + ' packs');

    if (currentInv?.packs !== batches._sum.quantityRemaining) {
      const diff = (currentInv?.packs || 0) - (batches._sum.quantityRemaining || 0);
      console.log('  ❌ DISCREPANCY: ' + Math.abs(diff) + ' packs ' +
                  (diff > 0 ? 'excess in inventory' : 'missing from inventory'));
    } else {
      console.log('  ✅ Inventory matches batch system');
    }
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
