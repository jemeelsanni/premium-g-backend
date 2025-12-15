/**
 * Scan All Products for Double-Deduction Bug Impact
 *
 * This script scans all warehouse products to identify which ones
 * have inventory discrepancies due to the double-deduction bug.
 *
 * Run with: node scripts/scan-all-products.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');

async function scanAllProducts() {
  console.log('\n🔍 SCANNING ALL WAREHOUSE PRODUCTS FOR DISCREPANCIES');
  console.log('=====================================================\n');

  try {
    const products = await prisma.product.findMany({
      where: {
        module: 'WAREHOUSE',
        isActive: true
      },
      include: {
        warehouseInventory: true
      }
    });

    console.log('Found', products.length, 'warehouse products\n');

    const discrepancies = [];

    for (const product of products) {
      // Get all purchases
      const purchases = await prisma.warehouseProductPurchase.findMany({
        where: { productId: product.id }
      });

      // Get all sales
      const sales = await prisma.warehouseSale.findMany({
        where: { productId: product.id }
      });

      // Calculate by unit type
      const calculateTotals = (transactions, qtyField) => {
        const totals = { pallets: 0, packs: 0, units: 0 };
        transactions.forEach(t => {
          const qty = t[qtyField] || 0;
          if (t.unitType === 'PACKS') totals.packs += qty;
          else if (t.unitType === 'PALLETS') totals.pallets += qty;
          else if (t.unitType === 'UNITS') totals.units += qty;
        });
        return totals;
      };

      const totalPurchased = calculateTotals(purchases, 'quantity');
      const totalSold = calculateTotals(sales, 'quantity');

      const expectedStock = {
        pallets: totalPurchased.pallets - totalSold.pallets,
        packs: totalPurchased.packs - totalSold.packs,
        units: totalPurchased.units - totalSold.units
      };

      const currentStock = {
        pallets: product.warehouseInventory[0]?.pallets || 0,
        packs: product.warehouseInventory[0]?.packs || 0,
        units: product.warehouseInventory[0]?.units || 0
      };

      const difference = {
        pallets: expectedStock.pallets - currentStock.pallets,
        packs: expectedStock.packs - currentStock.packs,
        units: expectedStock.units - currentStock.units
      };

      const hasDiff = difference.pallets !== 0 || difference.packs !== 0 || difference.units !== 0;

      if (hasDiff) {
        discrepancies.push({
          productId: product.id,
          productName: product.name,
          productNo: product.productNo,
          totalPurchased,
          totalSold,
          expectedStock,
          currentStock,
          difference,
          inventoryId: product.warehouseInventory[0]?.id
        });

        console.log('❌', product.name, '(' + product.productNo + ')');
        console.log('   Current: P:' + currentStock.pallets + ' | Pk:' + currentStock.packs + ' | U:' + currentStock.units);
        console.log('   Expected: P:' + expectedStock.pallets + ' | Pk:' + expectedStock.packs + ' | U:' + expectedStock.units);

        const diffP = difference.pallets > 0 ? '+' + difference.pallets : difference.pallets;
        const diffPk = difference.packs > 0 ? '+' + difference.packs : difference.packs;
        const diffU = difference.units > 0 ? '+' + difference.units : difference.units;

        console.log('   Diff: P:' + diffP + ' | Pk:' + diffPk + ' | U:' + diffU);
        console.log('');
      }
    }

    console.log('\n=====================================================');
    console.log('📊 SCAN SUMMARY');
    console.log('=====================================================');
    console.log('Total Products Scanned:', products.length);
    console.log('Products with Discrepancies:', discrepancies.length);
    console.log('Products OK:', products.length - discrepancies.length);
    console.log('');

    if (discrepancies.length > 0) {
      console.log('⚠️  PRODUCTS NEEDING CORRECTION:');
      discrepancies.forEach((d, idx) => {
        const total = Math.abs(d.difference.pallets) + Math.abs(d.difference.packs) + Math.abs(d.difference.units);
        console.log('  ' + (idx + 1) + '. ' + d.productName + ': ' + total + ' total units off');
      });

      // Save to file for the fix script
      const outputPath = __dirname + '/discrepancies.json';
      fs.writeFileSync(outputPath, JSON.stringify(discrepancies, null, 2));
      console.log('\n📁 Discrepancy details saved to:', outputPath);
      console.log('\nRun fix-all-discrepancies.js to correct these automatically.');
    } else {
      console.log('✅ All products have correct inventory!');
    }

    return discrepancies;

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

scanAllProducts();
