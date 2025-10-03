const { PrismaClient } = require('@prisma/client');
const { NotFoundError, ValidationError, BusinessError, UnauthorizedError } = require('../middleware/errorHandler');
const prisma = new PrismaClient();

const {
  generatePaymentReference,
  generateRiteFoodsOrderNumber,
  generateRiteFoodsInvoiceNumber
} = require('../utils/orderNumberGenerator');

class DistributionPaymentService {
  
  // Record customer payment (by sales rep or cashier)
  async recordCustomerPayment({
    orderId,
    amount,
    paymentMethod,
    reference,
    paidBy,
    receivedBy,
    notes,
    userId
  }) {
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId },
      include: { customer: true }
    });

    if (!order) {
      throw new NotFoundError('Distribution order not found');
    }

    if (order.paymentStatus === 'CONFIRMED') {
      throw new ValidationError('Payment already confirmed for this order');
    }

    return await prisma.$transaction(async (tx) => {
      // Record payment in history
      const payment = await tx.paymentHistory.create({
        data: {
          orderId,
          amount,
          paymentType: 'TO_COMPANY',
          paymentMethod,
          reference,
          paidBy: paidBy || order.customer.name,
          receivedBy,
          notes
        }
      });

      // Calculate total paid so far
      const totalPaid = await tx.paymentHistory.aggregate({
        where: {
          orderId,
          paymentType: 'TO_COMPANY'
        },
        _sum: { amount: true }
      });

      const totalAmountPaid = parseFloat(totalPaid._sum.amount || 0);
      const orderAmount = parseFloat(order.finalAmount);

      // Determine payment status
      let paymentStatus;
      if (totalAmountPaid >= orderAmount) {
        paymentStatus = 'CONFIRMED';
      } else if (totalAmountPaid > 0) {
        paymentStatus = 'PARTIAL';
      } else {
        paymentStatus = 'PENDING';
      }

      // Update order
      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: {
          amountPaid: totalAmountPaid,
          paymentMethod,
          paymentReference: reference,
          paymentStatus,
          paymentNotes: notes,
          balance: orderAmount - totalAmountPaid,
          status: paymentStatus === 'CONFIRMED' ? 'PAYMENT_CONFIRMED' : order.status
        },
        include: {
          customer: true,
          location: true,
          paymentHistory: {
            orderBy: { createdAt: 'desc' }
          }
        }
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId,
          action: 'CREATE',
          entity: 'PaymentHistory',
          entityId: payment.id,
          newValues: {
            orderId,
            amount,
            paymentMethod,
            paymentStatus
          }
        }
      });

      return { payment, order: updatedOrder };
    });
  }

  // Accountant confirms payment
  async confirmPayment(orderId, accountantUserId, notes) {
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    if (order.paymentStatus === 'CONFIRMED') {
      throw new ValidationError('Payment already confirmed');
    }

    const orderAmount = parseFloat(order.finalAmount);
    const amountPaid = parseFloat(order.amountPaid);

    if (amountPaid < orderAmount) {
      throw new ValidationError(
        `Cannot confirm payment. Outstanding balance: ₦${(orderAmount - amountPaid).toFixed(2)}`
      );
    }

    return await prisma.$transaction(async (tx) => {
      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: {
          paymentStatus: 'CONFIRMED',
          paymentConfirmedBy: accountantUserId,
          paymentConfirmedAt: new Date(),
          paymentNotes: notes,
          status: 'PAYMENT_CONFIRMED'
        },
        include: {
          customer: true,
          location: true,
          paymentConfirmer: {
            select: { username: true, role: true }
          }
        }
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId: accountantUserId,
          action: 'UPDATE',
          entity: 'DistributionOrder',
          entityId: orderId,
          oldValues: { paymentStatus: order.paymentStatus },
          newValues: { paymentStatus: 'CONFIRMED' }
        }
      });

      return updatedOrder;
    });
  }

  // Record payment to Rite Foods
  async recordPaymentToRiteFoods({
    orderId,
    amount,
    paymentMethod,
    reference,
    riteFoodsOrderNumber,
    riteFoodsInvoiceNumber,
    userId
  }) {
    // Get order
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        location: true,
        orderItems: {
          include: { product: true }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // Validation
    if (order.paymentStatus !== 'CONFIRMED') {
      throw new BusinessError('Customer payment must be confirmed before paying Rite Foods');
    }

    if (order.paidToRiteFoods) {
      throw new BusinessError('Payment to Rite Foods has already been recorded for this order');
    }

    const paymentAmount = parseFloat(amount);
    if (paymentAmount > parseFloat(order.finalAmount)) {
      throw new BusinessError('Payment amount cannot exceed order total');
    }

    // ✅ Generate numbers automatically if not provided
    const finalReference = reference || await generatePaymentReference();
    const finalRFOrderNumber = riteFoodsOrderNumber || await generateRiteFoodsOrderNumber();
    const finalRFInvoiceNumber = riteFoodsInvoiceNumber || await generateRiteFoodsInvoiceNumber();

    // Record payment in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Record payment to Rite Foods
      const payment = await tx.paymentHistory.create({
        data: {
          orderId,
          amount: paymentAmount,
          paymentMethod: paymentMethod,
          paymentType: 'TO_RITE_FOODS',
          reference: finalReference,
          notes: `Payment to Rite Foods - ${finalReference}`,
        }
      });

      // Update order
      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: {
          paidToRiteFoods: true,
          paymentDateToRiteFoods: new Date(),
          riteFoodsStatus: 'PAYMENT_SENT',
          riteFoodsOrderNumber: finalRFOrderNumber,
          riteFoodsInvoiceNumber: finalRFInvoiceNumber,
          status: 'SENT_TO_RITE_FOODS'
        },
        include: {
          customer: true,
          location: true,
          orderItems: {
            include: { product: true }
          }
        }
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId,
          action: 'PAY_RITE_FOODS',
          entity: 'DistributionOrder',
          entityId: orderId,
          newValues: {
            paymentReference: finalReference,
            riteFoodsOrderNumber: finalRFOrderNumber,
            riteFoodsInvoiceNumber: finalRFInvoiceNumber,
            amount: paymentAmount
          }
        }
      });

      return {
        order: updatedOrder,
        payment,
        paymentReference: finalReference,
        riteFoodsOrderNumber: finalRFOrderNumber,
        riteFoodsInvoiceNumber: finalRFInvoiceNumber
      };
    });

    return result;
  }

  // Update Rite Foods order status
  async updateRiteFoodsStatus({
    orderId,
    riteFoodsStatus,
    orderRaisedAt,
    loadedDate,
    userId
  }) {
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    const updateData = {
      riteFoodsStatus
    };

    // Handle specific status updates
    if (riteFoodsStatus === 'ORDER_RAISED') {
      updateData.orderRaisedByRFL = true;
      updateData.orderRaisedAt = orderRaisedAt || new Date();
      updateData.status = 'PROCESSING_BY_RFL';
    }

    if (riteFoodsStatus === 'LOADED') {
      updateData.riteFoodsLoadedDate = loadedDate || new Date();
      updateData.status = 'LOADED';
    }

    if (riteFoodsStatus === 'DISPATCHED') {
      updateData.status = 'IN_TRANSIT';
    }

    return await prisma.$transaction(async (tx) => {
      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: updateData,
        include: {
          customer: true,
          location: true
        }
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId,
          action: 'UPDATE',
          entity: 'DistributionOrder',
          entityId: orderId,
          oldValues: { riteFoodsStatus: order.riteFoodsStatus },
          newValues: { riteFoodsStatus }
        }
      });

      return updatedOrder;
    });
  }

  // Get payment summary for an order
  async getOrderPaymentSummary(orderId) {
    const [order, payments] = await Promise.all([
      prisma.distributionOrder.findUnique({
        where: { id: orderId },
        include: {
          customer: true,
          paymentConfirmer: {
            select: { username: true }
          }
        }
      }),
      prisma.paymentHistory.findMany({
        where: { orderId },
        orderBy: { createdAt: 'desc' }
      })
    ]);

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    const customerPayments = payments.filter(p => p.paymentType === 'TO_COMPANY');
    const riteFoodsPayments = payments.filter(p => p.paymentType === 'TO_RITE_FOODS');

    return {
      order: {
        id: order.id,
        customer: order.customer.name,
        totalAmount: parseFloat(order.finalAmount),
        amountPaid: parseFloat(order.amountPaid),
        balance: parseFloat(order.balance),
        paymentStatus: order.paymentStatus,
        confirmedBy: order.paymentConfirmer?.username,
        confirmedAt: order.paymentConfirmedAt
      },
      customerPayments: customerPayments.map(p => ({
        id: p.id,
        amount: parseFloat(p.amount),
        method: p.paymentMethod,
        reference: p.reference,
        receivedBy: p.receivedBy,
        date: p.createdAt
      })),
      riteFoodsPayment: riteFoodsPayments[0] ? {
        amount: parseFloat(riteFoodsPayments[0].amount),
        method: riteFoodsPayments[0].paymentMethod,
        reference: riteFoodsPayments[0].reference,
        paidAt: riteFoodsPayments[0].createdAt,
        orderNumber: order.riteFoodsOrderNumber,
        invoiceNumber: order.riteFoodsInvoiceNumber,
        status: order.riteFoodsStatus
      } : null
    };
  }
}

module.exports = new DistributionPaymentService();