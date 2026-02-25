const { NotFoundError, ValidationError, BusinessError } = require('../middleware/errorHandler');
const prisma = require('../lib/prisma');

class DistributionDeliveryService {

  // ================================
  // HELPER: Check if order is ready for transport assignment
  // ================================
  canAssignTransport(order) {
    const checks = {
      paymentConfirmed: order.paymentStatus === 'CONFIRMED',
      paidToSupplier: order.paidToSupplier === true,
      orderLoaded: ['LOADED', 'DISPATCHED'].includes(order.supplierStatus),
      balanceSettled: parseFloat(order.balance) === 0,
      transportNotAssigned: !order.transporterCompany
    };

    const allChecksPassed = Object.values(checks).every(check => check === true);

    return {
      canAssign: allChecksPassed,
      checks,
      blockers: Object.entries(checks)
        .filter(([key, value]) => !value)
        .map(([key]) => key)
    };
  }

  // ================================
  // Assign transport details
  // ================================
  async assignTransport({ orderId, transporterCompany, driverNumber, truckNumber, userId }) {
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        location: true
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // ✅ Use validation helper
    const readiness = this.canAssignTransport(order);
    
    if (!readiness.canAssign) {
      const blockerMessages = {
        paymentConfirmed: 'Customer payment must be confirmed by accountant',
        paidToSupplier: 'Payment to supplier must be completed',
        orderLoaded: 'Order must be loaded at supplier',
        balanceSettled: 'Outstanding balance must be settled',
        transportNotAssigned: 'Transport already assigned'
      };

      const errors = readiness.blockers.map(blocker => blockerMessages[blocker]);
      
      throw new BusinessError(
        `Cannot assign transport. Required: ${errors.join(', ')}`,
        'TRANSPORT_NOT_READY'
      );
    }

    return await prisma.$transaction(async (tx) => {
      // Update order with transport details
      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: {
          transporterCompany,
          driverNumber,
          truckNumber,
          status: 'IN_TRANSIT',
          deliveryStatus: 'IN_TRANSIT',
          supplierStatus: 'DISPATCHED'
        },
        include: {
          customer: true,
          location: true,
          orderItems: {
            include: { product: true }
          }
        }
      });

      // Create audit log
      await tx.auditLog.create({
        data: {
          userId,
          action: 'TRANSPORT_ASSIGNED',
          entity: 'DistributionOrder',
          entityId: orderId,
          newValues: {
            transporterCompany,
            driverNumber,
            truckNumber,
            status: 'IN_TRANSIT',
            deliveryStatus: 'IN_TRANSIT'
          }
        }
      });

      return updatedOrder;
    });
  }

  // ================================
  // Record delivery (full, partial, or failed)
  // ================================
  async recordDelivery({
    orderId,
    deliveryStatus,
    deliveredPallets,
    deliveredPacks,
    deliveredBy,
    deliveryNotes,
    nonDeliveryReason,
    partialDeliveryReason,
    reviewerId
  }) {
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        orderItems: {
          include: { product: true }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    // Validate delivery quantities
    if (deliveryStatus === 'FULLY_DELIVERED') {
      deliveredPallets = order.totalPallets;
      deliveredPacks = order.totalPacks;
    } else if (deliveryStatus === 'PARTIALLY_DELIVERED') {
      if (!deliveredPallets && !deliveredPacks) {
        throw new ValidationError('Must specify delivered quantities for partial delivery');
      }
      if (!partialDeliveryReason) {
        throw new ValidationError('Must provide reason for partial delivery');
      }
    } else if (deliveryStatus === 'FAILED') {
      deliveredPallets = 0;
      deliveredPacks = 0;
      if (!nonDeliveryReason) {
        throw new ValidationError('Must provide reason for failed delivery');
      }
    }

    return await prisma.$transaction(async (tx) => {
      // Determine final order status
      let finalStatus;
      if (deliveryStatus === 'FULLY_DELIVERED') {
        finalStatus = 'DELIVERED';
      } else if (deliveryStatus === 'PARTIALLY_DELIVERED') {
        finalStatus = 'PARTIALLY_DELIVERED';
      } else {
        finalStatus = 'CANCELLED';
      }

      // Update order
      const updatedOrder = await tx.distributionOrder.update({
        where: { id: orderId },
        data: {
          deliveryStatus,
          deliveredPallets,
          deliveredPacks,
          deliveredAt: new Date(),
          deliveredBy,
          deliveryNotes,
          nonDeliveryReason,
          partialDeliveryReason,
          deliveryReviewedBy: reviewerId,
          deliveryReviewedAt: new Date(),
          status: finalStatus
        },
        include: {
          customer: true,
          location: true,
          orderItems: {
            include: { product: true }
          },
          deliveryReviewer: {
            select: { username: true, role: true }
          }
        }
      });

      // Update customer analytics for successful deliveries
      if (deliveryStatus === 'FULLY_DELIVERED' || deliveryStatus === 'PARTIALLY_DELIVERED') {
        await tx.customer.update({
          where: { id: order.customerId },
          data: {
            totalOrders: { increment: 1 },
            totalSpent: { increment: order.finalAmount },
            lastOrderDate: new Date()
          }
        });

        // Update customer's average order value
      //   const customerOrders = await tx.distributionOrder.count({
      //     where: {
      //       customerId: order.customerId,
      //       status: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
      //     }
      //   });

      //   const customerTotalSpent = await tx.distributionOrder.aggregate({
      //     where: {
      //       customerId: order.customerId,
      //       status: { in: ['DELIVERED', 'PARTIALLY_DELIVERED'] }
      //     },
      //     _sum: { finalAmount: true }
      //   });

      //   const avgOrderValue = customerOrders > 0 
      //     ? parseFloat(customerTotalSpent._sum.finalAmount) / customerOrders 
      //     : 0;

      //   await tx.customer.update({
      //     where: { id: order.customerId },
      //     data: {
      //       averageOrderValue: avgOrderValue
      //     }
      //   });
      }

      // Audit log
      await tx.auditLog.create({
        data: {
          userId: reviewerId,
          action: 'UPDATE',
          entity: 'DistributionOrder',
          entityId: orderId,
          newValues: {
            deliveryStatus,
            deliveredPallets,
            deliveredPacks,
            status: finalStatus
          }
        }
      });

      return updatedOrder;
    });
  }

  // ================================
  // Get delivery summary
  // ================================
  async getDeliverySummary(orderId) {
    const order = await prisma.distributionOrder.findUnique({
      where: { id: orderId },
      include: {
        customer: true,
        location: true,
        deliveryReviewer: {
          select: { username: true, role: true }
        }
      }
    });

    if (!order) {
      throw new NotFoundError('Order not found');
    }

    const deliveryRate = order.totalPacks > 0 
      ? (order.deliveredPacks / order.totalPacks) * 100 
      : 0;

    return {
      order: {
        id: order.id,
        customer: order.customer.name,
        location: order.location.name,
        transporter: order.transporterCompany,
        driver: order.driverNumber,
        truck: order.truckNumber
      },
      ordered: {
        pallets: order.totalPallets,
        packs: order.totalPacks
      },
      delivered: {
        pallets: order.deliveredPallets || 0,
        packs: order.deliveredPacks || 0,
        deliveryRate: `${deliveryRate.toFixed(2)}%`
      },
      status: {
        delivery: order.deliveryStatus,
        order: order.status,
        deliveredAt: order.deliveredAt,
        deliveredBy: order.deliveredBy
      },
      notes: {
        delivery: order.deliveryNotes,
        partial: order.partialDeliveryReason,
        failed: order.nonDeliveryReason
      },
      reviewer: {
        name: order.deliveryReviewer?.username,
        reviewedAt: order.deliveryReviewedAt
      }
    };
  }
}

module.exports = new DistributionDeliveryService();