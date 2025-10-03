const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

/**
 * Generate sequential order number for distribution orders
 * Format: ORD-2025-001
 */
const generateDistributionOrderNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `ORD-${year}-`;

  // Get the last order number for this year
  const lastOrder = await prisma.distributionOrder.findFirst({
    where: {
      orderNumber: {
        startsWith: prefix
      }
    },
    orderBy: {
      orderNumber: 'desc'
    },
    select: {
      orderNumber: true
    }
  });

  let nextNumber = 1;
  if (lastOrder && lastOrder.orderNumber) {
    const lastNumberStr = lastOrder.orderNumber.split('-')[2];
    nextNumber = parseInt(lastNumberStr) + 1;
  }

  return `${prefix}${String(nextNumber).padStart(3, '0')}`;
};

/**
 * Generate payment reference for Rite Foods payments
 * Format: TRX-RF-001
 */
const generatePaymentReference = async () => {
  const prefix = 'TRX-RF-';

  const lastPayment = await prisma.paymentHistory.findFirst({
    where: {
      paymentType: 'TO_RITE_FOODS',
      reference: {
        startsWith: prefix
      }
    },
    orderBy: {
      reference: 'desc'
    },
    select: {
      reference: true
    }
  });

  let nextNumber = 1;
  if (lastPayment && lastPayment.reference) {
    const lastNumberStr = lastPayment.reference.split('-')[2];
    nextNumber = parseInt(lastNumberStr) + 1;
  }

  return `${prefix}${String(nextNumber).padStart(3, '0')}`;
};

/**
 * Generate Rite Foods order number
 * Format: RFL-ORD-2025-001
 */
const generateRiteFoodsOrderNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `RFL-ORD-${year}-`;

  const lastOrder = await prisma.distributionOrder.findFirst({
    where: {
      riteFoodsOrderNumber: {
        startsWith: prefix
      }
    },
    orderBy: {
      riteFoodsOrderNumber: 'desc'
    },
    select: {
      riteFoodsOrderNumber: true
    }
  });

  let nextNumber = 1;
  if (lastOrder && lastOrder.riteFoodsOrderNumber) {
    const lastNumberStr = lastOrder.riteFoodsOrderNumber.split('-')[3];
    nextNumber = parseInt(lastNumberStr) + 1;
  }

  return `${prefix}${String(nextNumber).padStart(3, '0')}`;
};

/**
 * Generate Rite Foods invoice number
 * Format: RFL-INV-2025-001
 */
const generateRiteFoodsInvoiceNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `RFL-INV-${year}-`;

  const lastOrder = await prisma.distributionOrder.findFirst({
    where: {
      riteFoodsInvoiceNumber: {
        startsWith: prefix
      }
    },
    orderBy: {
      riteFoodsInvoiceNumber: 'desc'
    },
    select: {
      riteFoodsInvoiceNumber: true
    }
  });

  let nextNumber = 1;
  if (lastOrder && lastOrder.riteFoodsInvoiceNumber) {
    const lastNumberStr = lastOrder.riteFoodsInvoiceNumber.split('-')[3];
    nextNumber = parseInt(lastNumberStr) + 1;
  }

  return `${prefix}${String(nextNumber).padStart(3, '0')}`;
};

module.exports = {
  generateDistributionOrderNumber,
  generatePaymentReference,
  generateRiteFoodsOrderNumber,
  generateRiteFoodsInvoiceNumber
};