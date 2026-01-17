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
 * Generate payment reference for supplier payments
 * Format: TRX-SUP-001
 */
const generatePaymentReference = async () => {
  const prefix = 'TRX-SUP-';

  const lastPayment = await prisma.paymentHistory.findFirst({
    where: {
      paymentType: 'TO_SUPPLIER',
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
 * Generate supplier order number
 * Format: SUP-ORD-2025-001
 */
const generateSupplierOrderNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `SUP-ORD-${year}-`;

  const lastOrder = await prisma.distributionOrder.findFirst({
    where: {
      supplierOrderNumber: {
        startsWith: prefix
      }
    },
    orderBy: {
      supplierOrderNumber: 'desc'
    },
    select: {
      supplierOrderNumber: true
    }
  });

  let nextNumber = 1;
  if (lastOrder && lastOrder.supplierOrderNumber) {
    const lastNumberStr = lastOrder.supplierOrderNumber.split('-')[3];
    nextNumber = parseInt(lastNumberStr) + 1;
  }

  return `${prefix}${String(nextNumber).padStart(3, '0')}`;
};

/**
 * Generate supplier invoice number
 * Format: SUP-INV-2025-001
 */
const generateSupplierInvoiceNumber = async () => {
  const year = new Date().getFullYear();
  const prefix = `SUP-INV-${year}-`;

  const lastOrder = await prisma.distributionOrder.findFirst({
    where: {
      supplierInvoiceNumber: {
        startsWith: prefix
      }
    },
    orderBy: {
      supplierInvoiceNumber: 'desc'
    },
    select: {
      supplierInvoiceNumber: true
    }
  });

  let nextNumber = 1;
  if (lastOrder && lastOrder.supplierInvoiceNumber) {
    const lastNumberStr = lastOrder.supplierInvoiceNumber.split('-')[3];
    nextNumber = parseInt(lastNumberStr) + 1;
  }

  return `${prefix}${String(nextNumber).padStart(3, '0')}`;
};

module.exports = {
  generateDistributionOrderNumber,
  generatePaymentReference,
  generateSupplierOrderNumber,
  generateSupplierInvoiceNumber
};