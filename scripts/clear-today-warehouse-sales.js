/**
 * Script to clear all Warehouse Sales for today (February 23, 2025)
 * This will also reverse batch quantities and delete related records
 * Run with: node scripts/clear-today-warehouse-sales.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearTodayWarehouseSales() {
  // Set today's date range
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  console.log(`Clearing warehouse sales for: ${today.toDateString()}\n`);

  try {
    // 1. Find all sales for today
    const todaySales = await prisma.warehouseSale.findMany({
      where: {
        createdAt: {
          gte: today,
          lt: tomorrow
        }
      },
      include: {
        warehouseBatchSales: true,
        product: { select: { name: true, id: true } }
      }
    });

    console.log(`Found ${todaySales.length} sale(s) to delete\n`);

    if (todaySales.length === 0) {
      console.log('No sales found for today.');
      return;
    }

    // Track products that need inventory sync
    const affectedProductIds = new Set();

    // 2. Process each sale
    for (const sale of todaySales) {
      console.log(`Processing sale: ${sale.receiptNumber}`);
      console.log(`  Product: ${sale.product.name}`);
      console.log(`  Quantity: ${sale.quantity}`);
      console.log(`  Total: ₦${sale.totalAmount}`);

      affectedProductIds.add(sale.productId);

      // 3. Reverse batch quantities for each batch sale record
      for (const batchSale of sale.warehouseBatchSales) {
        await prisma.warehouseProductPurchase.update({
          where: { id: batchSale.batchId },
          data: {
            quantityRemaining: { increment: batchSale.quantitySold },
            quantitySold: { decrement: batchSale.quantitySold },
            batchStatus: 'ACTIVE'
          }
        });
        console.log(`  Restored ${batchSale.quantitySold} to batch`);
      }

      // 4. Delete batch sale tracking records
      await prisma.warehouseBatchSale.deleteMany({
        where: { saleId: sale.id }
      });

      // 5. Delete related cash flow entries
      await prisma.cashFlow.deleteMany({
        where: {
          module: 'WAREHOUSE',
          referenceNumber: sale.receiptNumber
        }
      });

      // 6. Delete the sale
      await prisma.warehouseSale.delete({
        where: { id: sale.id }
      });

      console.log(`  ✅ Deleted\n`);
    }

    // 7. Sync inventory for affected products
    console.log('Syncing inventory for affected products...\n');

    for (const productId of affectedProductIds) {
      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { name: true }
      });

      const batchTotals = await prisma.warehouseProductPurchase.aggregate({
        where: {
          productId: productId,
          batchStatus: 'ACTIVE'
        },
        _sum: { quantityRemaining: true }
      });

      const totalStock = batchTotals._sum.quantityRemaining || 0;

      await prisma.warehouseInventory.upsert({
        where: {
          productId_location: {
            productId: productId,
            location: 'main'
          }
        },
        update: {
          packs: totalStock,
          units: 0,
          pallets: 0
        },
        create: {
          productId: productId,
          location: 'main',
          packs: totalStock,
          units: 0,
          pallets: 0
        }
      });

      console.log(`${product?.name}: ${totalStock} packs in stock`);
    }

    console.log('\n========================================');
    console.log(`Total sales deleted: ${todaySales.length}`);
    console.log('Inventory has been restored.');
    console.log('========================================\n');

  } catch (error) {
    console.error('Error clearing sales:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
clearTodayWarehouseSales()
  .then(() => {
    console.log('Script completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
