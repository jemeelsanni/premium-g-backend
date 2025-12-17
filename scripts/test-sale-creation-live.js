const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('\n🧪 TESTING CURRENT SALE CREATION BEHAVIOR\n');
    console.log('='.repeat(80));

    // Get a product with inventory
    const product = await prisma.product.findFirst({
      where: {
        name: { contains: '35CL BIGI' }
      }
    });

    if (!product) {
      console.log('❌ Product not found');
      return;
    }

    // Get current state BEFORE
    const invBefore = await prisma.warehouseInventory.findFirst({
      where: { productId: product.id }
    });

    const batchesBefore = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: product.id,
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
        unitType: 'PACKS'
      }
    });

    const totalBeforeBatches = batchesBefore.reduce((sum, b) => sum + b.quantityRemaining, 0);

    console.log('\n📊 BEFORE STATE:');
    console.log('  Product: ' + product.name);
    console.log('  Inventory Table: ' + (invBefore?.packs || 0) + ' packs');
    console.log('  Batch System: ' + totalBeforeBatches + ' packs');
    console.log('  Match: ' + (invBefore?.packs === totalBeforeBatches ? '✅' : '❌'));

    // Get the most recent sale
    const recentSale = await prisma.warehouseSale.findFirst({
      where: {
        productId: product.id,
        unitType: 'PACKS'
      },
      include: {
        warehouseBatchSales: true
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!recentSale) {
      console.log('\n❌ No sales found to test');
      return;
    }

    console.log('\n📝 MOST RECENT SALE:');
    console.log('  Receipt: ' + recentSale.receiptNumber);
    console.log('  Date: ' + new Date(recentSale.createdAt).toLocaleString('en-GB'));
    console.log('  Quantity: ' + recentSale.quantity + ' packs');
    console.log('  Batch Allocations: ' + recentSale.warehouseBatchSales.length);

    // Check if batch allocations match sale quantity
    const totalAllocated = recentSale.warehouseBatchSales.reduce((sum, bs) =>
      sum + bs.quantitySold, 0
    );

    console.log('  Total Allocated from Batches: ' + totalAllocated + ' packs');

    if (totalAllocated !== recentSale.quantity) {
      console.log('  ❌ MISMATCH: Sale quantity (' + recentSale.quantity +
                  ') != Batch allocated (' + totalAllocated + ')');
    } else {
      console.log('  ✅ Match');
    }

    // Get current state AFTER
    const invAfter = await prisma.warehouseInventory.findFirst({
      where: { productId: product.id }
    });

    const batchesAfter = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: product.id,
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
        unitType: 'PACKS'
      }
    });

    const totalAfterBatches = batchesAfter.reduce((sum, b) => sum + b.quantityRemaining, 0);

    console.log('\n📊 CURRENT STATE:');
    console.log('  Inventory Table: ' + (invAfter?.packs || 0) + ' packs');
    console.log('  Batch System: ' + totalAfterBatches + ' packs');
    console.log('  Match: ' + (invAfter?.packs === totalAfterBatches ? '✅' : '❌'));

    // Expected inventory after sale
    const expectedAfterSale = totalBeforeBatches - recentSale.quantity;
    console.log('\n  Expected After This Sale: ' + expectedAfterSale + ' packs');

    if (invAfter?.packs !== totalAfterBatches) {
      console.log('  ❌ PROBLEM: Inventory table does not match batch system!');
      console.log('     This means auto-sync is NOT working properly.');
    }

    // Check all recent sales (today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todaySales = await prisma.warehouseSale.findMany({
      where: {
        productId: product.id,
        unitType: 'PACKS',
        createdAt: { gte: today }
      },
      include: {
        warehouseBatchSales: true,
        warehouseCustomer: { select: { name: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    console.log('\n📅 TODAY\'S SALES (' + todaySales.length + '):');
    todaySales.forEach((sale, i) => {
      const time = new Date(sale.createdAt).toLocaleTimeString('en-GB');
      const customer = sale.warehouseCustomer?.name || 'Walk-in';
      const allocated = sale.warehouseBatchSales.reduce((sum, bs) => sum + bs.quantitySold, 0);
      const match = allocated === sale.quantity ? '✅' : '❌';

      console.log('  ' + (i + 1) + '. ' + time + ' - ' + sale.quantity + ' packs to ' +
                  customer + ' (Allocated: ' + allocated + ') ' + match);
    });

    console.log('\n='.repeat(80));

    // Final check - are there any discrepancies NOW?
    const allProducts = await prisma.product.findMany({
      where: {
        warehouseInventory: { some: {} }
      },
      include: {
        warehouseInventory: true
      }
    });

    let discrepancyCount = 0;
    const discrepancies = [];

    for (const prod of allProducts) {
      const inv = prod.warehouseInventory[0];
      if (!inv) continue;

      const batches = await prisma.warehouseProductPurchase.aggregate({
        where: {
          productId: prod.id,
          batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
          unitType: 'PACKS'
        },
        _sum: { quantityRemaining: true }
      });

      const batchTotal = batches._sum.quantityRemaining || 0;

      if (inv.packs !== batchTotal) {
        discrepancyCount++;
        discrepancies.push({
          product: prod.name,
          inventory: inv.packs,
          batches: batchTotal,
          diff: inv.packs - batchTotal
        });
      }
    }

    console.log('\n🔍 CURRENT SYSTEM-WIDE CHECK:');
    console.log('  Products with discrepancies: ' + discrepancyCount);

    if (discrepancies.length > 0) {
      console.log('\n  ⚠️  ACTIVE DISCREPANCIES FOUND:');
      discrepancies.forEach(d => {
        console.log('    - ' + d.product + ': Inventory=' + d.inventory +
                    ', Batches=' + d.batches + ', Diff=' + d.diff);
      });
      console.log('\n  ❌ AUTO-SYNC IS NOT WORKING!');
    } else {
      console.log('  ✅ All products match - auto-sync is working');
    }

    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
