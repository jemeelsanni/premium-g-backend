

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function clearDatabase() {
  console.log('🧹 Starting database cleanup...\n');
  
  try {
    const tables = [
      { name: 'Warehouse Sale Discounts', model: prisma.warehouseSaleDiscount },
      { name: 'Warehouse Customer Discounts', model: prisma.warehouseCustomerDiscount },
      { name: 'Discount Approval Requests', model: prisma.discountApprovalRequest },
      { name: 'Debtor Payments', model: prisma.debtorPayment },
      { name: 'Debtors', model: prisma.debtor },
      { name: 'Warehouse Expenses', model: prisma.warehouseExpense },
      { name: 'Warehouse Product Purchases', model: prisma.warehouseProductPurchase },
      { name: 'Warehouse Sales', model: prisma.warehouseSale },
      { name: 'Warehouse Customers', model: prisma.warehouseCustomer },
      { name: 'Warehouse Inventory', model: prisma.warehouseInventory },
      { name: 'Profit Analysis', model: prisma.profitAnalysis },
      { name: 'Expenses', model: prisma.expense },
      { name: 'Transport Orders', model: prisma.transportOrder },
      { name: 'Truck Capacity', model: prisma.truckCapacity },
      { name: 'Cash Flow', model: prisma.cashFlow },
      { name: 'Distribution Order Items', model: prisma.distributionOrderItem },
      { name: 'Distribution Orders', model: prisma.distributionOrder },
      { name: 'Distribution Customers', model: prisma.distributionCustomer },
      { name: 'Weekly Performance', model: prisma.weeklyPerformance },
      { name: 'Distribution Targets', model: prisma.distributionTarget },
      { name: 'Price Adjustments', model: prisma.priceAdjustment },
      { name: 'Products', model: prisma.product },
      { name: 'Locations', model: prisma.location },
      { name: 'Audit Logs', model: prisma.auditLog },
      { name: 'User Sessions', model: prisma.userSession },
      { name: 'Users', model: prisma.user }
    ];

    for (const table of tables) {
      try {
        const result = await table.model.deleteMany({});
        console.log(`✅ Cleared ${table.name}: ${result.count} records deleted`);
      } catch (error) {
        console.log(`⚠️  Could not clear ${table.name}: ${error.message}`);
      }
    }

    // Verify all tables are empty
    console.log('\n🔍 Verifying database is empty...');
    const userCount = await prisma.user.count();
    const productCount = await prisma.product.count();
    const locationCount = await prisma.location.count();
    const orderCount = await prisma.distributionOrder.count();
    const saleCount = await prisma.warehouseSale.count();

    console.log('\n📊 VERIFICATION SUMMARY:');
    console.log('========================');
    console.log(`Users: ${userCount}`);
    console.log(`Products: ${productCount}`);
    console.log(`Locations: ${locationCount}`);
    console.log(`Distribution Orders: ${orderCount}`);
    console.log(`Warehouse Sales: ${saleCount}`);

    if (userCount === 0 && productCount === 0 && locationCount === 0) {
      console.log('\n✅ Database successfully cleared!');
    } else {
      console.log('\n⚠️  Some data may still remain in the database');
    }

  } catch (error) {
    console.error('❌ Error clearing database:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

clearDatabase()
  .then(() => {
    console.log('\n🎉 Database cleanup completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Database cleanup failed:', error);
    process.exit(1);
  });