/**
 * Script to clear all Distribution and Transport data from the database
 * Run with: node scripts/clear-distribution-transport.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearDistributionAndTransportData() {
  console.log('Starting to clear Distribution and Transport data...\n');

  try {
    // ==========================================
    // DISTRIBUTION MODULE - Clear in order
    // ==========================================
    console.log('=== Clearing Distribution Data ===\n');

    // 1. Clear child tables first
    const deletedOrderItems = await prisma.distributionOrderItem.deleteMany({});
    console.log(`Deleted ${deletedOrderItems.count} distribution order items`);

    const deletedPaymentHistory = await prisma.paymentHistory.deleteMany({});
    console.log(`Deleted ${deletedPaymentHistory.count} payment history records`);

    const deletedPriceAdjustments = await prisma.priceAdjustment.deleteMany({});
    console.log(`Deleted ${deletedPriceAdjustments.count} price adjustments`);

    // 2. Clear profit analysis for distribution orders
    const deletedDistProfitAnalysis = await prisma.profitAnalysis.deleteMany({
      where: { analysisType: 'ORDER' }
    });
    console.log(`Deleted ${deletedDistProfitAnalysis.count} distribution profit analysis records`);

    // 3. Clear distribution orders (after children are deleted)
    const deletedDistOrders = await prisma.distributionOrder.deleteMany({});
    console.log(`Deleted ${deletedDistOrders.count} distribution orders`);

    // 4. Clear customers
    const deletedCustomers = await prisma.customer.deleteMany({});
    console.log(`Deleted ${deletedCustomers.count} customers`);

    // 5. Clear targets
    const deletedWeeklyPerformance = await prisma.weeklyPerformance.deleteMany({});
    console.log(`Deleted ${deletedWeeklyPerformance.count} weekly performance records`);

    const deletedDistTargets = await prisma.distributionTarget.deleteMany({});
    console.log(`Deleted ${deletedDistTargets.count} distribution targets`);

    const deletedSupplierTargets = await prisma.supplierTarget.deleteMany({});
    console.log(`Deleted ${deletedSupplierTargets.count} supplier targets`);

    const deletedSupplierIncentives = await prisma.supplierIncentive.deleteMany({});
    console.log(`Deleted ${deletedSupplierIncentives.count} supplier incentives`);

    // 6. Clear distribution analytics
    const deletedDistAnalytics = await prisma.distributionAnalytics.deleteMany({});
    console.log(`Deleted ${deletedDistAnalytics.count} distribution analytics records`);

    console.log('\n=== Clearing Transport Data ===\n');

    // ==========================================
    // TRANSPORT MODULE - Clear in order
    // ==========================================

    // 1. Clear transport profit analysis
    const deletedTransProfitAnalysis = await prisma.profitAnalysis.deleteMany({
      where: { analysisType: 'TRANSPORT_TRIP' }
    });
    console.log(`Deleted ${deletedTransProfitAnalysis.count} transport profit analysis records`);

    // 2. Clear transport orders
    const deletedTransOrders = await prisma.transportOrder.deleteMany({});
    console.log(`Deleted ${deletedTransOrders.count} transport orders`);

    // 3. Clear transport expenses
    const deletedExpenses = await prisma.expense.deleteMany({});
    console.log(`Deleted ${deletedExpenses.count} expenses`);

    // 4. Clear transport analytics
    const deletedTransAnalytics = await prisma.transportAnalytics.deleteMany({});
    console.log(`Deleted ${deletedTransAnalytics.count} transport analytics records`);

    // 5. Clear trucks (optional - comment out if you want to keep truck records)
    const deletedTrucks = await prisma.truckCapacity.deleteMany({});
    console.log(`Deleted ${deletedTrucks.count} trucks`);

    // 6. Clear transport-related cash flow
    const deletedCashFlow = await prisma.cashFlow.deleteMany({
      where: { module: 'TRANSPORT' }
    });
    console.log(`Deleted ${deletedCashFlow.count} transport cash flow records`);

    // ==========================================
    // Clear remaining profit analysis
    // ==========================================
    const deletedRemainingProfitAnalysis = await prisma.profitAnalysis.deleteMany({});
    console.log(`\nDeleted ${deletedRemainingProfitAnalysis.count} remaining profit analysis records`);

    console.log('\n========================================');
    console.log('Distribution and Transport data cleared successfully!');
    console.log('========================================\n');

  } catch (error) {
    console.error('Error clearing data:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
clearDistributionAndTransportData()
  .then(() => {
    console.log('Script completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
