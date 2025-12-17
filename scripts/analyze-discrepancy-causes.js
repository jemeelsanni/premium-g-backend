const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('\n🔍 ANALYZING ROOT CAUSES OF INVENTORY DISCREPANCIES\n');
    console.log('='.repeat(80));

    // Get all products with discrepancies
    const products = await prisma.product.findMany({
      where: {
        warehouseInventory: { some: {} }
      },
      include: {
        warehouseInventory: true
      }
    });

    console.log('\nAnalyzing ' + products.length + ' products...\n');

    const issues = [];

    for (const product of products) {
      const inv = product.warehouseInventory[0];
      if (!inv) continue;

      // Get all batches
      const batches = await prisma.warehouseProductPurchase.findMany({
        where: {
          productId: product.id,
          batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
          unitType: 'PACKS'
        }
      });

      if (batches.length === 0) continue;

      // Get all sales
      const allSales = await prisma.warehouseSale.findMany({
        where: {
          productId: product.id,
          unitType: 'PACKS'
        },
        include: {
          warehouseBatchSales: true
        }
      });

      // Calculate totals
      const totalPurchased = batches.reduce((sum, b) => sum + b.quantity, 0);
      const totalSoldFromSales = allSales.reduce((sum, s) => sum + s.quantity, 0);
      const totalSoldFromBatches = batches.reduce((sum, b) => sum + b.quantitySold, 0);
      const totalRemainingFromBatches = batches.reduce((sum, b) => sum + b.quantityRemaining, 0);

      // Get batch sales table total
      const batchSalesTotal = await prisma.warehouseBatchSale.aggregate({
        where: {
          sale: {
            productId: product.id,
            unitType: 'PACKS'
          }
        },
        _sum: { quantitySold: true }
      });

      const totalBatchSalesLinked = batchSalesTotal._sum.quantitySold || 0;

      // Check for inconsistencies
      const salesVsBatchSales = totalSoldFromSales - totalBatchSalesLinked;
      const batchSoldVsBatchSalesLinked = totalSoldFromBatches - totalBatchSalesLinked;
      const batchSoldVsSales = totalSoldFromBatches - totalSoldFromSales;
      const expectedRemaining = totalPurchased - totalSoldFromSales;
      const actualRemaining = totalRemainingFromBatches;
      const remainingDiscrepancy = actualRemaining - expectedRemaining;

      // Check each sale for consistency
      let salesWithMismatch = 0;
      for (const sale of allSales) {
        const saleQty = sale.quantity;
        const batchAllocated = sale.warehouseBatchSales.reduce((sum, bs) => sum + bs.quantitySold, 0);
        if (saleQty !== batchAllocated) {
          salesWithMismatch++;
        }
      }

      if (Math.abs(remainingDiscrepancy) > 0 || salesWithMismatch > 0 ||
          Math.abs(batchSoldVsBatchSalesLinked) > 0) {
        issues.push({
          product: product.name,
          totalPurchased,
          totalSoldFromSales,
          totalSoldFromBatches,
          totalBatchSalesLinked,
          totalRemainingFromBatches,
          expectedRemaining,
          currentInventory: inv.packs,
          discrepancies: {
            salesVsBatchSales,
            batchSoldVsBatchSalesLinked,
            batchSoldVsSales,
            remainingDiscrepancy,
            salesWithMismatch,
            inventoryVsExpected: inv.packs - expectedRemaining,
            inventoryVsActual: inv.packs - actualRemaining
          }
        });
      }
    }

    if (issues.length > 0) {
      console.log('❌ Found ' + issues.length + ' products with issues:\n');

      issues.forEach(issue => {
        console.log('━'.repeat(80));
        console.log('📦 ' + issue.product);
        console.log('');
        console.log('  Purchased: ' + issue.totalPurchased + ' packs');
        console.log('  Sold (Sales Table): ' + issue.totalSoldFromSales + ' packs');
        console.log('  Sold (Batch quantitySold): ' + issue.totalSoldFromBatches + ' packs');
        console.log('  Sold (BatchSales Table): ' + issue.totalBatchSalesLinked + ' packs');
        console.log('');
        console.log('  Remaining (Batches): ' + issue.totalRemainingFromBatches + ' packs');
        console.log('  Expected Remaining: ' + issue.expectedRemaining + ' packs');
        console.log('  Current Inventory: ' + issue.currentInventory + ' packs');
        console.log('');
        console.log('  🔍 Discrepancies:');

        if (issue.discrepancies.batchSoldVsBatchSalesLinked !== 0) {
          console.log('    ⚠️  Batch quantitySold vs BatchSales: ' +
                      issue.discrepancies.batchSoldVsBatchSalesLinked + ' packs');
          console.log('        → This indicates ORPHANED batch deductions (sales were deleted but batch not restored)');
        }

        if (issue.discrepancies.salesVsBatchSales !== 0) {
          console.log('    ⚠️  Sales vs BatchSales: ' +
                      issue.discrepancies.salesVsBatchSales + ' packs');
          console.log('        → This indicates MISSING batch allocations (sales without batch links)');
        }

        if (issue.discrepancies.salesWithMismatch > 0) {
          console.log('    ⚠️  Sales with batch mismatch: ' +
                      issue.discrepancies.salesWithMismatch + ' sales');
          console.log('        → Individual sale quantities don\'t match their batch allocations');
        }

        if (issue.discrepancies.remainingDiscrepancy !== 0) {
          console.log('    ⚠️  Remaining stock discrepancy: ' +
                      issue.discrepancies.remainingDiscrepancy + ' packs');
          console.log('        → Actual batch remaining differs from expected');
        }

        if (issue.discrepancies.inventoryVsExpected !== 0) {
          console.log('    ⚠️  Inventory vs Expected: ' +
                      issue.discrepancies.inventoryVsExpected + ' packs');
          console.log('        → Inventory table needs sync from batches');
        }

        console.log('');
      });

      // Categorize root causes
      console.log('━'.repeat(80));
      console.log('\n📋 ROOT CAUSE SUMMARY:\n');

      const orphanedBatchDeductions = issues.filter(i =>
        i.discrepancies.batchSoldVsBatchSalesLinked > 0
      ).length;

      const missingSyncIssues = issues.filter(i =>
        Math.abs(i.discrepancies.inventoryVsActual) > 0
      ).length;

      if (orphanedBatchDeductions > 0) {
        console.log('  1. ⚠️  ORPHANED BATCH DEDUCTIONS (' + orphanedBatchDeductions + ' products)');
        console.log('     When: Sales are deleted but batch quantitySold is not restored');
        console.log('     Effect: Batches show more sold than actual sales table');
        console.log('     Fix: Restore batch quantitySold and quantityRemaining');
        console.log('');
      }

      if (missingSyncIssues > 0) {
        console.log('  2. ⚠️  INVENTORY TABLE OUT OF SYNC (' + missingSyncIssues + ' products)');
        console.log('     When: Inventory table not updated after batch changes');
        console.log('     Effect: Inventory doesn\'t match batch system');
        console.log('     Fix: Run auto-sync after every sale/deletion');
        console.log('');
      }

      console.log('  ROOT CAUSE: The "delete sale" bug was creating phantom stock.');
      console.log('  When sales were deleted:');
      console.log('    ✅ BatchSales records were deleted (correct)');
      console.log('    ❌ Batch quantitySold was NOT restored (BUG!)');
      console.log('    ❌ Inventory was incremented anyway (BUG!)');
      console.log('');
      console.log('  This created excess inventory that doesn\'t exist in reality.');

    } else {
      console.log('✅ No issues found! All products are consistent.\n');
    }

    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
