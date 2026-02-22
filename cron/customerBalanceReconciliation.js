// cron/customerBalanceReconciliation.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Reconcile customer balances with their order balances
 * Runs every 5 minutes to ensure data consistency
 */
async function reconcileCustomerBalances() {
  try {
    console.log('🔄 [Customer Balance Reconciliation] Starting...');

    // Get all customers who have orders
    const customers = await prisma.customer.findMany({
      where: {
        totalOrders: {
          gt: 0
        }
      },
      select: {
        id: true,
        name: true,
        customerBalance: true
      }
    });

    let fixedCount = 0;
    let checkedCount = 0;
    const discrepancies = [];

    for (const customer of customers) {
      checkedCount++;

      // Get all orders for this customer
      const orders = await prisma.distributionOrder.findMany({
        where: { customerId: customer.id },
        select: {
          orderNumber: true,
          balance: true
        }
      });

      // Calculate the correct balance
      // Order balance: Positive = customer owes us, Negative = we owe customer
      // Customer balance: Inverted - Negative = customer owes us, Positive = we owe customer
      const totalOrderBalance = orders.reduce((sum, order) => {
        return sum + parseFloat(order.balance || 0);
      }, 0);

      const correctCustomerBalance = -totalOrderBalance;
      const currentBalance = parseFloat(customer.customerBalance);

      // Check for discrepancy (allowing for small floating point differences)
      const difference = Math.abs(currentBalance - correctCustomerBalance);

      if (difference > 0.01) {
        discrepancies.push({
          customerId: customer.id,
          customerName: customer.name,
          currentBalance: currentBalance,
          correctBalance: correctCustomerBalance,
          difference: currentBalance - correctCustomerBalance,
          orderCount: orders.length
        });

        // Fix the balance
        await prisma.customer.update({
          where: { id: customer.id },
          data: {
            customerBalance: correctCustomerBalance
          }
        });

        fixedCount++;
      }
    }

    // Log results
    if (discrepancies.length > 0) {
      console.log(`⚠️  [Customer Balance Reconciliation] Found ${discrepancies.length} discrepancies:`);
      discrepancies.forEach(d => {
        console.log(`   - ${d.customerName}:`);
        console.log(`     Current: ₦${d.currentBalance.toLocaleString()}`);
        console.log(`     Correct: ₦${d.correctBalance.toLocaleString()}`);
        console.log(`     Difference: ₦${d.difference.toLocaleString()}`);
        console.log(`     Orders: ${d.orderCount}`);
      });
      console.log(`✅ [Customer Balance Reconciliation] Fixed ${fixedCount} customer balances`);
    } else {
      console.log(`✅ [Customer Balance Reconciliation] All ${checkedCount} customers have correct balances`);
    }

  } catch (error) {
    console.error('❌ [Customer Balance Reconciliation] Error:', error);
  }
}

module.exports = { reconcileCustomerBalances };
