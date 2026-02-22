// Check customer orders and balances in detail
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkCustomerOrders() {
  console.log('🔍 Checking customer orders in detail...\n');

  try {
    // Get all customers
    const customers = await prisma.customer.findMany({
      select: {
        id: true,
        name: true,
        customerBalance: true
      }
    });

    for (const customer of customers) {
      console.log(`\n${'='.repeat(80)}`);
      console.log(`👤 Customer: ${customer.name}`);
      console.log(`💰 Current Customer Balance in DB: ₦${parseFloat(customer.customerBalance || 0).toLocaleString()}`);
      console.log(`${'='.repeat(80)}\n`);

      // Get all orders for this customer
      const orders = await prisma.distributionOrder.findMany({
        where: { customerId: customer.id },
        select: {
          id: true,
          orderNumber: true,
          originalAmount: true,
          finalAmount: true,
          amountPaid: true,
          balance: true,
          paymentStatus: true,
          createdAt: true
        },
        orderBy: {
          createdAt: 'desc'
        }
      });

      console.log(`📦 Total Orders: ${orders.length}\n`);

      let totalOrderBalance = 0;

      orders.forEach((order, index) => {
        const originalAmount = parseFloat(order.originalAmount);
        const finalAmount = parseFloat(order.finalAmount);
        const amountPaid = parseFloat(order.amountPaid);
        const balance = parseFloat(order.balance);

        totalOrderBalance += balance;

        console.log(`Order ${index + 1}: ${order.orderNumber || order.id.substring(0, 8)}`);
        console.log(`  📅 Date: ${new Date(order.createdAt).toLocaleDateString()}`);
        console.log(`  💵 Original Amount: ₦${originalAmount.toLocaleString()}`);
        console.log(`  💵 Final Amount: ₦${finalAmount.toLocaleString()}`);
        console.log(`  💰 Amount Paid: ₦${amountPaid.toLocaleString()}`);
        console.log(`  📊 Order Balance: ₦${balance.toLocaleString()} ${balance > 0 ? '(Customer owes us)' : balance < 0 ? '(We owe customer)' : '(Settled)'}`);
        console.log(`  🏷️  Payment Status: ${order.paymentStatus}`);
        console.log('');
      });

      console.log(`${'─'.repeat(80)}`);
      console.log(`📊 Summary:`);
      console.log(`  Total Order Balance (sum): ₦${totalOrderBalance.toLocaleString()}`);
      console.log(`  Expected Customer Balance: ₦${(-totalOrderBalance).toLocaleString()}`);
      console.log(`  Current Customer Balance: ₦${parseFloat(customer.customerBalance || 0).toLocaleString()}`);
      console.log(`  Match: ${Math.abs(parseFloat(customer.customerBalance) - (-totalOrderBalance)) < 0.01 ? '✅ YES' : '❌ NO'}`);

      if (totalOrderBalance > 0) {
        console.log(`\n  💡 Customer owes: ₦${totalOrderBalance.toLocaleString()}`);
      } else if (totalOrderBalance < 0) {
        console.log(`\n  💡 Customer has credit: ₦${Math.abs(totalOrderBalance).toLocaleString()}`);
      } else {
        console.log(`\n  💡 Customer account is settled`);
      }
    }

  } catch (error) {
    console.error('❌ Error checking orders:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkCustomerOrders();
