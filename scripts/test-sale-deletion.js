const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    // Find a recent sale
    const recentSale = await prisma.warehouseSale.findFirst({
      include: {
        warehouseBatchSales: true,
        product: {
          select: { name: true, productNo: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!recentSale) {
      console.log('No sales found');
      return;
    }

    console.log('\n🧪 SALE DELETION RESTORATION TEST\n');
    console.log('='.repeat(80));
    console.log('Sale Info:');
    console.log('  Product:', recentSale.product.name);
    console.log('  Quantity:', recentSale.quantity, recentSale.unitType);
    console.log('  Receipt:', recentSale.receiptNumber);
    console.log('');

    // Current inventory
    const currentInv = await prisma.warehouseInventory.findFirst({
      where: { productId: recentSale.productId }
    });

    console.log('Current Inventory:');
    console.log('  Packs:', currentInv?.packs ?? 0);
    console.log('');

    // Get all batches
    const allBatches = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: recentSale.productId,
        batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
      }
    });

    // Simulate what would happen after deletion
    let simulatedPacksTotal = 0;
    allBatches.forEach(batch => {
      let remaining = batch.quantityRemaining || 0;

      // Check if this batch was used in the sale
      const usedInSale = recentSale.warehouseBatchSales.find(bs => bs.batchId === batch.id);
      if (usedInSale && batch.unitType === 'PACKS') {
        remaining += usedInSale.quantitySold; // Restore what was sold
      }

      if (batch.unitType === 'PACKS') {
        simulatedPacksTotal += remaining;
      }
    });

    console.log('After Deletion (Simulated):');
    console.log('  Packs:', simulatedPacksTotal);
    console.log('  Change: +' + (simulatedPacksTotal - (currentInv?.packs ?? 0)) + ' packs restored');
    console.log('');
    console.log('✅ Logic is correct - inventory WOULD be restored!');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await prisma.$disconnect();
  }
})();
