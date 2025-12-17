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

    console.log('\n🔍 FINDING MISSING 2 PACKS - 35CL BIGI\n');
    console.log('='.repeat(80));

    // Get all sales and their batch allocations
    const allSales = await prisma.warehouseSale.findMany({
      where: {
        productId: product.id,
        unitType: 'PACKS'
      },
      include: {
        warehouseBatchSales: {
          include: {
            batch: { select: { batchNumber: true, expiryDate: true } }
          }
        },
        warehouseCustomer: { select: { name: true } }
      },
      orderBy: { createdAt: 'asc' }
    });

    console.log('\nTotal Sales: ' + allSales.length);

    // Calculate discrepancies per sale
    let totalDiscrepancy = 0;
    const problematicSales = [];

    allSales.forEach(sale => {
      const saleQty = sale.quantity;
      const batchAllocatedQty = sale.warehouseBatchSales.reduce((sum, bs) =>
        sum + bs.quantitySold, 0
      );

      if (saleQty !== batchAllocatedQty) {
        const diff = batchAllocatedQty - saleQty;
        totalDiscrepancy += diff;
        problematicSales.push({
          receipt: sale.receiptNumber,
          date: new Date(sale.createdAt).toLocaleString('en-GB'),
          customer: sale.warehouseCustomer?.name || 'Walk-in',
          saleQty,
          batchQty: batchAllocatedQty,
          discrepancy: diff
        });
      }
    });

    if (problematicSales.length > 0) {
      console.log('\n❌ Found ' + problematicSales.length + ' sales with discrepancies:');
      console.log('');
      problematicSales.forEach(s => {
        console.log('  Receipt: ' + s.receipt);
        console.log('  Date: ' + s.date);
        console.log('  Customer: ' + s.customer);
        console.log('  Sale Quantity: ' + s.saleQty + ' packs');
        console.log('  Batch Allocated: ' + s.batchQty + ' packs');
        console.log('  Discrepancy: ' + (s.discrepancy > 0 ? '+' : '') + s.discrepancy + ' packs');
        console.log('');
      });

      console.log('Total Discrepancy: ' + totalDiscrepancy + ' packs');
    } else {
      console.log('\n✅ All sales match their batch allocations perfectly');
      console.log('\nThis means the 2-pack discrepancy occurred during:');
      console.log('  1. A deleted sale that was not properly reversed');
      console.log('  2. Manual batch adjustments');
      console.log('  3. The historical double-deduction bug');
    }

    // Get all batch sales totals
    const batchSalesTotals = await prisma.warehouseBatchSale.aggregate({
      where: {
        sale: {
          productId: product.id,
          unitType: 'PACKS'
        }
      },
      _sum: { quantitySold: true }
    });

    const salesTotals = await prisma.warehouseSale.aggregate({
      where: {
        productId: product.id,
        unitType: 'PACKS'
      },
      _sum: { quantity: true }
    });

    console.log('\n' + '='.repeat(80));
    console.log('Summary:');
    console.log('  Sales Table Total: ' + (salesTotals._sum.quantity || 0) + ' packs');
    console.log('  Batch Sales Total: ' + (batchSalesTotals._sum.quantitySold || 0) + ' packs');
    console.log('  Difference: ' + ((batchSalesTotals._sum.quantitySold || 0) - (salesTotals._sum.quantity || 0)) + ' packs');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
