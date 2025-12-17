/**
 * Daily Stock Continuity Validator
 *
 * Ensures that for any given date:
 * Opening Stock (Day N) = Closing Stock (Day N-1)
 *
 * This validates the fundamental accounting principle:
 * Today's opening stock MUST equal yesterday's closing stock
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function calculateDailyStock(productId, date, product) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);

  // Get all purchases up to end of this day (ACTIVE and DEPLETED only)
  const purchasesUpToEndOfDay = await prisma.warehouseProductPurchase.findMany({
    where: {
      productId,
      purchaseDate: { lte: endOfDay },
      batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
      unitType: 'PACKS'
    }
  });

  // Get all sales up to end of this day
  const salesUpToEndOfDay = await prisma.warehouseSale.aggregate({
    where: {
      productId,
      createdAt: { lte: endOfDay },
      unitType: 'PACKS'
    },
    _sum: { quantity: true }
  });

  const totalPurchased = purchasesUpToEndOfDay.reduce((sum, p) => sum + p.quantity, 0);
  const totalSold = salesUpToEndOfDay._sum.quantity || 0;
  const closingStock = totalPurchased - totalSold;

  return closingStock;
}

(async () => {
  try {
    console.log('\n📊 DAILY STOCK CONTINUITY VALIDATION\n');
    console.log('='.repeat(80));

    // Get all products with inventory
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        module: 'WAREHOUSE',
        warehouseInventory: { some: {} }
      },
      select: { id: true, name: true, productNo: true }
    });

    console.log(`Total Products: ${products.length}\n`);

    // Define date range to check (last 7 days)
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dates = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      dates.push(date);
    }

    console.log('📅 Checking Date Range:');
    console.log(`   From: ${dates[0].toLocaleDateString('en-GB')}`);
    console.log(`   To: ${dates[dates.length - 1].toLocaleDateString('en-GB')}`);
    console.log('');

    let totalChecks = 0;
    let totalDiscrepancies = 0;
    const discrepancyDetails = [];

    // For each product, check continuity across dates
    for (const product of products) {
      let previousClosing = null;
      let previousDate = null;

      for (const date of dates) {
        const closingStock = await calculateDailyStock(product.id, date, product);

        // Check if opening stock (closing of previous day) matches
        if (previousClosing !== null) {
          totalChecks++;

          const openingStock = previousClosing; // Opening = previous day's closing
          const expectedOpening = previousClosing;

          // The opening stock should equal previous closing
          // We can verify this by checking if:
          // Closing(Day N-1) = Closing(Day N-1) ✅ (always true by definition)
          // But we need to check if our CALCULATION is consistent

          // Calculate what the closing should be based on previous closing + movements
          const purchasesToday = await prisma.warehouseProductPurchase.aggregate({
            where: {
              productId: product.id,
              purchaseDate: { gte: date, lte: new Date(date.getTime() + 86400000 - 1) },
              batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
              unitType: 'PACKS'
            },
            _sum: { quantity: true }
          });

          const salesToday = await prisma.warehouseSale.aggregate({
            where: {
              productId: product.id,
              createdAt: { gte: date, lte: new Date(date.getTime() + 86400000 - 1) },
              unitType: 'PACKS'
            },
            _sum: { quantity: true }
          });

          const purchasesQty = purchasesToday._sum.quantity || 0;
          const salesQty = salesToday._sum.quantity || 0;

          const calculatedClosing = openingStock + purchasesQty - salesQty;

          // Check if calculated closing matches actual closing
          if (calculatedClosing !== closingStock) {
            totalDiscrepancies++;
            discrepancyDetails.push({
              product: product.name,
              productNo: product.productNo,
              date: date.toLocaleDateString('en-GB'),
              previousDate: previousDate.toLocaleDateString('en-GB'),
              previousClosing,
              openingStock,
              purchasesToday: purchasesQty,
              salesToday: salesQty,
              calculatedClosing,
              actualClosing: closingStock,
              discrepancy: closingStock - calculatedClosing
            });
          }
        }

        previousClosing = closingStock;
        previousDate = date;
      }
    }

    console.log('='.repeat(80));
    console.log('📊 VALIDATION RESULTS:\n');
    console.log(`   Total Continuity Checks: ${totalChecks}`);
    console.log(`   Discrepancies Found: ${totalDiscrepancies}`);
    console.log('');

    if (totalDiscrepancies === 0) {
      console.log('✅ ALL CHECKS PASSED!');
      console.log('   Opening stock = Previous closing stock for all products and dates');
    } else {
      console.log('❌ DISCREPANCIES FOUND:\n');

      discrepancyDetails.forEach(d => {
        console.log(`📦 ${d.product} (${d.productNo})`);
        console.log(`   Date: ${d.date}`);
        console.log(`   Previous Closing (${d.previousDate}): ${d.previousClosing} packs`);
        console.log(`   Opening (${d.date}): ${d.openingStock} packs ✅`);
        console.log(`   Purchases Today: +${d.purchasesToday} packs`);
        console.log(`   Sales Today: -${d.salesToday} packs`);
        console.log(`   Calculated Closing: ${d.calculatedClosing} packs`);
        console.log(`   Actual Closing: ${d.actualClosing} packs`);
        console.log(`   Discrepancy: ${d.discrepancy} packs ❌`);
        console.log('');
      });

      console.log('⚠️  ROOT CAUSE:');
      console.log('   This indicates that transactions are not being counted correctly,');
      console.log('   or there are batches/sales that should be excluded but aren\'t.');
    }

    console.log('='.repeat(80));

    // Additional check: Verify current inventory matches today's closing
    console.log('\n🔍 CURRENT INVENTORY VALIDATION:\n');

    let inventoryMismatches = 0;

    for (const product of products) {
      const todayClosing = await calculateDailyStock(product.id, today, product);

      const currentInventory = await prisma.warehouseInventory.findFirst({
        where: { productId: product.id }
      });

      if (currentInventory && currentInventory.packs !== todayClosing) {
        inventoryMismatches++;
        console.log(`❌ ${product.name}:`);
        console.log(`   Current Inventory: ${currentInventory.packs} packs`);
        console.log(`   Today's Closing: ${todayClosing} packs`);
        console.log(`   Difference: ${currentInventory.packs - todayClosing} packs`);
        console.log('');
      }
    }

    if (inventoryMismatches === 0) {
      console.log('✅ All current inventory matches today\'s closing stock');
    } else {
      console.log(`❌ ${inventoryMismatches} products have inventory mismatches`);
      console.log('   Run: node scripts/fix-all-discrepancies.js');
    }

    console.log('\n' + '='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
