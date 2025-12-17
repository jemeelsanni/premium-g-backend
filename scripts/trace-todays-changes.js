const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('\n🔍 TRACING TODAY\'S INVENTORY CHANGES\n');
    console.log('='.repeat(80));

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get all sales today
    const todaySales = await prisma.warehouseSale.findMany({
      where: {
        createdAt: { gte: today },
        unitType: 'PACKS'
      },
      include: {
        product: { select: { name: true } },
        warehouseCustomer: { select: { name: true } },
        warehouseBatchSales: true
      },
      orderBy: { createdAt: 'asc' }
    });

    // Get all purchases today
    const todayPurchases = await prisma.warehouseProductPurchase.findMany({
      where: {
        purchaseDate: { gte: today },
        unitType: 'PACKS'
      },
      include: {
        product: { select: { name: true } }
      },
      orderBy: { purchaseDate: 'asc' }
    });

    console.log('\n📦 TODAY\'S PURCHASES: ' + todayPurchases.length);
    todayPurchases.forEach(p => {
      const time = new Date(p.purchaseDate).toLocaleTimeString('en-GB');
      console.log('  ' + time + ' - ' + p.product.name + ': +' + p.quantity + ' packs');
    });

    console.log('\n🛒 TODAY\'S SALES: ' + todaySales.length);
    todaySales.forEach(s => {
      const time = new Date(s.createdAt).toLocaleTimeString('en-GB');
      const customer = s.warehouseCustomer?.name || 'Walk-in';
      const allocated = s.warehouseBatchSales.reduce((sum, bs) => sum + bs.quantitySold, 0);
      const match = allocated === s.quantity;

      console.log('  ' + time + ' - ' + s.product.name + ': -' + s.quantity +
                  ' packs to ' + customer + ' (Receipt: ' + s.receiptNumber + ')');
      console.log('      Batch allocated: ' + allocated + ' ' + (match ? '✅' : '❌ MISMATCH!'));
    });

    // Check for any sales/purchases deleted or modified today
    const todayAudits = await prisma.auditLog.findMany({
      where: {
        createdAt: { gte: today },
        entity: { in: ['WarehouseSale', 'WarehouseProductPurchase', 'WarehouseInventory'] }
      },
      orderBy: { createdAt: 'asc' },
      take: 50
    });

    console.log('\n📝 TODAY\'S AUDIT LOGS: ' + todayAudits.length);
    todayAudits.forEach(log => {
      const time = new Date(log.createdAt).toLocaleTimeString('en-GB');
      const user = log.userId ? 'User ' + log.userId : 'System';
      console.log('  ' + time + ' - ' + log.action + ' ' + log.entity + ' by ' + user);

      if (log.metadata) {
        const meta = typeof log.metadata === 'string' ? JSON.parse(log.metadata) : log.metadata;
        if (meta.productName) {
          console.log('      Product: ' + meta.productName);
        }
        if (meta.triggeredBy) {
          console.log('      Triggered by: ' + meta.triggeredBy);
        }
        if (meta.reason) {
          console.log('      Reason: ' + meta.reason);
        }
      }
    });

    // Calculate net change per product today
    console.log('\n📊 NET CHANGES BY PRODUCT (Today):');
    const productChanges = {};

    todayPurchases.forEach(p => {
      if (!productChanges[p.product.name]) {
        productChanges[p.product.name] = { purchases: 0, sales: 0, net: 0 };
      }
      productChanges[p.product.name].purchases += p.quantity;
    });

    todaySales.forEach(s => {
      if (!productChanges[s.product.name]) {
        productChanges[s.product.name] = { purchases: 0, sales: 0, net: 0 };
      }
      productChanges[s.product.name].sales += s.quantity;
    });

    Object.keys(productChanges).forEach(productName => {
      const change = productChanges[productName];
      change.net = change.purchases - change.sales;

      if (change.purchases > 0 || change.sales > 0) {
        console.log('  ' + productName + ':');
        if (change.purchases > 0) console.log('    Purchases: +' + change.purchases);
        if (change.sales > 0) console.log('    Sales: -' + change.sales);
        console.log('    Net: ' + (change.net >= 0 ? '+' : '') + change.net);
      }
    });

    // Check current inventory status
    console.log('\n='.repeat(80));
    console.log('🔍 CURRENT INVENTORY STATUS:\n');

    const allProducts = await prisma.product.findMany({
      where: {
        warehouseInventory: { some: {} }
      },
      include: {
        warehouseInventory: true
      }
    });

    let totalInvTable = 0;
    let totalBatches = 0;
    let discrepancyCount = 0;

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
      totalInvTable += inv.packs;
      totalBatches += batchTotal;

      if (inv.packs !== batchTotal) {
        discrepancyCount++;
        console.log('  ❌ ' + prod.name + ': Inv=' + inv.packs + ', Batches=' + batchTotal +
                    ', Diff=' + (inv.packs - batchTotal));
      }
    }

    console.log('\n  Total Inventory (Table): ' + totalInvTable + ' packs');
    console.log('  Total Inventory (Batches): ' + totalBatches + ' packs');
    console.log('  Products with discrepancies: ' + discrepancyCount);

    if (discrepancyCount === 0) {
      console.log('  ✅ All products match!');
    } else {
      console.log('  ❌ Discrepancies found!');
    }

    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
