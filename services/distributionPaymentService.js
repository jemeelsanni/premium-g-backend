const { PrismaClient } = require('@prisma/client');
const { NotFoundError, ValidationError, BusinessError, UnauthorizedError } = require('../middleware/errorHandler');
const prisma = new PrismaClient();

const {
  generatePaymentReference,
  generateSupplierOrderNumber,
  generateSupplierInvoiceNumber
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

      // Calculate the change in balance
      const oldBalance = parseFloat(order.balance);
      const newBalance = orderAmount - totalAmountPaid;
      const balanceChange = newBalance - oldBalance;

      // Update order
      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: {
          amountPaid: totalAmountPaid,
          paymentMethod,
          paymentReference: reference,
          paymentStatus,
          paymentNotes: notes,
          balance: newBalance,
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

      // Update customer balance
      // When customer pays more, their balance decreases (they owe less)
      // balanceChange is negative when payment reduces the balance
      await tx.customer.update({
        where: { id: order.customerId },
        data: {
          customerBalance: {
            increment: balanceChange
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

    const amountPaid = parseFloat(order.amountPaid);

    // ✅ Allow confirming payment regardless of outstanding balance
    // Customer can pay remaining balance later via customer detail page
    // Outstanding balance tracked in customer.customerBalance
    if (amountPaid <= 0) {
      throw new ValidationError(
        'Cannot confirm payment. Customer has not made any payment yet.'
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
  async recordPaymentToSupplier({
    orderId,
    amount,
    paymentMethod,
    reference,
    supplierOrderNumber,
    supplierInvoiceNumber,
    userId
  }) {
    // Get order with supplier company
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        location: true,
        supplierCompany: true,
        orderItems: {
          include: { product: true }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    if (!order.supplierCompany) {
      throw new BusinessError('No supplier company assigned to this order');
    }

    // Validation
    if (order.paymentStatus !== 'CONFIRMED') {
      throw new BusinessError(`Customer payment must be confirmed before paying ${order.supplierCompany.name}`);
    }

    if (order.paidToSupplier) {
      throw new BusinessError(`Payment to ${order.supplierCompany.name} has already been recorded for this order`);
    }

    const paymentAmount = parseFloat(amount);
    if (paymentAmount > parseFloat(order.finalAmount)) {
      throw new BusinessError('Payment amount cannot exceed order total');
    }

    // ✅ Generate payment reference and invoice number automatically if not provided
    const supplierCode = order.supplierCompany.code;
    const finalReference = reference || await generatePaymentReference();
    const finalSupplierInvoiceNumber = supplierInvoiceNumber || await generateSupplierInvoiceNumber(supplierCode);

    // Record payment in transaction
    const result = await prisma.$transaction(async (tx) => {
      // Record payment to supplier
      const payment = await tx.paymentHistory.create({
        data: {
          orderId,
          amount: paymentAmount,
          paymentMethod: paymentMethod,
          paymentType: 'TO_SUPPLIER',
          reference: finalReference,
          notes: `Payment to ${order.supplierCompany.name} - ${finalReference}`,
        }
      });

      // Update order
      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: {
          paidToSupplier: true,
          amountPaidToSupplier: paymentAmount,
          paymentDateToSupplier: new Date(),
          supplierStatus: 'PAYMENT_SENT',
          supplierInvoiceNumber: finalSupplierInvoiceNumber,
          status: 'SENT_TO_SUPPLIER'
        },
        include: {
          customer: true,
          location: true,
          supplierCompany: true,
          orderItems: {
            include: { product: true }
          }
        }
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId,
          action: 'PAY_SUPPLIER',
          entity: 'DistributionOrder',
          entityId: orderId,
          newValues: {
            paymentReference: finalReference,
            supplierInvoiceNumber: finalSupplierInvoiceNumber,
            amount: paymentAmount,
            supplierName: order.supplierCompany.name
          }
        }
      });

      return {
        order: updatedOrder,
        payment,
        paymentReference: finalReference,
        supplierInvoiceNumber: finalSupplierInvoiceNumber
      };
    });

    return result;
  }

  // Update supplier order status
  async updateSupplierStatus({
    orderId,
    supplierStatus,
    orderRaisedAt,
    loadedDate,
    supplierReferenceNumber,
    userId
  }) {
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId },
      include: {
        supplierCompany: true
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    if (!order.supplierCompany) {
      throw new BusinessError('No supplier company assigned to this order');
    }

    const updateData = {
      supplierStatus
    };

    // Handle specific status updates
    if (supplierStatus === 'ORDER_RAISED') {
      if (!supplierReferenceNumber) {
        throw new BusinessError('Supplier reference number is required when setting status to ORDER_RAISED');
      }
      updateData.orderRaisedBySupplier = true;
      updateData.orderRaisedAt = orderRaisedAt || new Date();
      updateData.supplierOrderNumber = supplierReferenceNumber;
      updateData.status = 'PROCESSING_BY_SUPPLIER';
    }

    if (supplierStatus === 'LOADED') {
      updateData.supplierLoadedDate = loadedDate || new Date();
      updateData.status = 'LOADED';
    }

    if (supplierStatus === 'DISPATCHED') {
      updateData.status = 'IN_TRANSIT';
    }

    return await prisma.$transaction(async (tx) => {
      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: updateData,
        include: {
          customer: true,
          location: true,
          supplierCompany: true
        }
      });

      // Audit log
      await tx.auditLog.create({
        data: {
          userId,
          action: 'UPDATE',
          entity: 'DistributionOrder',
          entityId: orderId,
          oldValues: { supplierStatus: order.supplierStatus },
          newValues: { supplierStatus }
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
    const supplierPayments = payments.filter(p => p.paymentType === 'TO_SUPPLIER');

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
      supplierPayment: supplierPayments[0] ? {
        amount: parseFloat(supplierPayments[0].amount),
        method: supplierPayments[0].paymentMethod,
        reference: supplierPayments[0].reference,
        paidAt: supplierPayments[0].createdAt,
        orderNumber: order.supplierOrderNumber,
        invoiceNumber: order.supplierInvoiceNumber,
        status: order.supplierStatus
      } : null
    };
  }
}

module.exports = new DistributionPaymentService();