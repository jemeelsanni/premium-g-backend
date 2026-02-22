// Recalculate all customer balances based on their orders
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function recalculateCustomerBalances() {
  console.log('🔄 Starting customer balance recalculation...\n');

  try {
    // Get all customers
    const customers = await prisma.customer.findMany({
      select: { id: true, name: true }
    });

    console.log(`Found ${customers.length} customers\n`);

    for (const customer of customers) {
      // Get all orders for this customer
      const orders = await prisma.distributionOrder.findMany({
        where: { customerId: customer.id },
        select: { balance: true }
      });

      // Calculate total order balance
      const totalOrderBalance = orders.reduce((sum, order) => {
        return sum + parseFloat(order.balance || 0);
      }, 0);

      // Invert sign: order balance (positive = debt) -> customer balance (negative = debt)
      const customerBalance = -totalOrderBalance;

      // Update customer balance
      await prisma.customer.update({
        where: { id: customer.id },
        data: { customerBalance: customerBalance }
      });

      console.log(`✅ ${customer.name}:`);
      console.log(`   Orders: ${orders.length}`);
      console.log(`   Total Order Balance: ₦${totalOrderBalance.toLocaleString()}`);
      console.log(`   Customer Balance: ₦${customerBalance.toLocaleString()}`);
      console.log(`   Status: ${customerBalance < 0 ? 'DEBT' : customerBalance > 0 ? 'CREDIT' : 'SETTLED'}\n`);
    }

    console.log('✅ All customer balances recalculated successfully!');
  } catch (error) {
    console.error('❌ Error recalculating customer balances:', error);
  } finally {
    await prisma.$disconnect();
  }
}

recalculateCustomerBalances();
