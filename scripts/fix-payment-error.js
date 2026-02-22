// Fix payment error in Order ORD-2026-002
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Retry helper function
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      const delay = baseDelay * attempt;
      console.log(`⚠️  Attempt ${attempt} failed. Retrying in ${delay/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function fixPaymentError() {
  console.log('🔧 Fixing payment error for Order ORD-2026-002...\n');

  try {
    // Find the order with retry
    const order = await retryWithBackoff(async () => {
      return await prisma.distributionOrder.findFirst({
        where: { orderNumber: 'ORD-2026-002' },
        include: { customer: true }
      });
    });

    if (!order) {
      console.log('❌ Order ORD-2026-002 not found');
      return;
    }

    console.log('📦 Found Order:', order.orderNumber);
    console.log('💰 Current Amount Paid: ₦' + parseFloat(order.amountPaid).toLocaleString());
    console.log('💵 Order Total: ₦' + parseFloat(order.finalAmount).toLocaleString());
    console.log('📊 Current Balance: ₦' + parseFloat(order.balance).toLocaleString());
    console.log('\n🔄 Fixing payment from ₦720,000 to ₦72,000...\n');

    // Fix the payment in a transaction
    await prisma.$transaction(async (tx) => {
      // Update the order
      const correctedAmountPaid = 72000;
      const newBalance = parseFloat(order.finalAmount) - correctedAmountPaid;

      // Determine payment status
      let paymentStatus = 'PENDING';
      if (correctedAmountPaid >= parseFloat(order.finalAmount)) {
        paymentStatus = 'CONFIRMED';
      } else if (correctedAmountPaid > 0) {
        paymentStatus = 'PARTIAL';
      }

      await tx.distributionOrder.update({
        where: { id: order.id },
        data: {
          amountPaid: correctedAmountPaid,
          balance: newBalance,
          paymentStatus: paymentStatus
        }
      });

      console.log('✅ Order updated:');
      console.log('   New Amount Paid: ₦' + correctedAmountPaid.toLocaleString());
      console.log('   New Balance: ₦' + newBalance.toLocaleString());
      console.log('   Payment Status: ' + paymentStatus);

      // Recalculate customer balance
      const allOrders = await tx.distributionOrder.findMany({
        where: { customerId: order.customerId },
        select: { balance: true }
      });

      const totalOrderBalance = allOrders.reduce((sum, o) => {
        return sum + parseFloat(o.balance || 0);
      }, 0);

      const customerBalance = -totalOrderBalance;

      await tx.customer.update({
        where: { id: order.customerId },
        data: { customerBalance: customerBalance }
      });

      console.log('\n✅ Customer balance updated:');
      console.log('   Total Order Balance: ₦' + totalOrderBalance.toLocaleString());
      console.log('   Customer Balance: ₦' + customerBalance.toLocaleString());
      console.log('   Status: ' + (customerBalance < 0 ? 'DEBT (customer owes us)' : customerBalance > 0 ? 'CREDIT (we owe customer)' : 'SETTLED'));
    });

    console.log('\n✅ Payment error fixed successfully!');

  } catch (error) {
    console.error('❌ Error fixing payment:', error);
  } finally {
    await prisma.$disconnect();
  }
}

fixPaymentError();
