// ============================================
// FINAL FIX: routes/warehouse-debtors.js
// ============================================
// Corrected relation names based on Prisma schema

const express = require('express');
const router = express.Router();
const { PrismaClient } = require('@prisma/client');
const { body, query, validationResult } = require('express-validator');
const { authorizeModule } = require('../middleware/auth');
const { asyncHandler, ValidationError } = require('../middleware/errorHandler');

const prisma = new PrismaClient();

// ================================
// GET ALL DEBTORS (GROUPED BY RECEIPT)
// ================================
router.get('/',
  authorizeModule('warehouse', 'read'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
    query('status').optional().isIn(['OUTSTANDING', 'PARTIAL', 'OVERDUE', 'PAID', 'all'])
  ],
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, status = 'all' } = req.query;

    // Build filter for status
    const where = {};
    if (status !== 'all') {
      where.status = status;
    }

    // Get all debtors with their sales
    const debtors = await prisma.debtor.findMany({
      where,
      include: {
        warehouseCustomer: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            customerType: true,
            paymentReliabilityScore: true
          }
        },
        sale: {
          select: {
            id: true,
            receiptNumber: true,
            quantity: true,
            unitType: true,
            unitPrice: true,
            totalAmount: true,
            createdAt: true,
            paymentMethod: true,
            paymentStatus: true,
            product: {
              select: {
                id: true,
                name: true,
                productNo: true
              }
            }
          }
        },
        payments: {
          orderBy: { paymentDate: 'desc' }
        }
      },
      orderBy: [
        { createdAt: 'desc' }
      ]
    });

    // Group debtors by receiptNumber
    const receiptMap = new Map();

    for (const debtor of debtors) {
      const receiptNumber = debtor.sale.receiptNumber;

      if (!receiptMap.has(receiptNumber)) {
        receiptMap.set(receiptNumber, {
          receiptNumber,
          customer: {
            id: debtor.warehouseCustomer.id,
            name: debtor.warehouseCustomer.name,
            phone: debtor.warehouseCustomer.phone,
            email: debtor.warehouseCustomer.email,
            customerType: debtor.warehouseCustomer.customerType,
            paymentReliabilityScore: debtor.warehouseCustomer.paymentReliabilityScore
          },
          totalAmount: 0,
          amountPaid: 0,
          amountDue: 0,
          status: 'OUTSTANDING',
          dueDate: debtor.dueDate,
          createdAt: debtor.sale.createdAt,
          paymentMethod: debtor.sale.paymentMethod,
          products: [],
          debtorIds: [],
          allPayments: []
        });
      }

      const receipt = receiptMap.get(receiptNumber);

      // Aggregate amounts
      receipt.totalAmount += parseFloat(debtor.totalAmount);
      receipt.amountPaid += parseFloat(debtor.amountPaid);
      receipt.amountDue += parseFloat(debtor.amountDue);

      // Track debtor IDs for payment
      receipt.debtorIds.push(debtor.id);

      // Add product details
      receipt.products.push({
        debtorId: debtor.id,
        saleId: debtor.saleId,
        product: debtor.sale.product,
        quantity: debtor.sale.quantity,
        unitType: debtor.sale.unitType,
        unitPrice: parseFloat(debtor.sale.unitPrice),
        totalAmount: parseFloat(debtor.totalAmount),
        amountPaid: parseFloat(debtor.amountPaid),
        amountDue: parseFloat(debtor.amountDue),
        status: debtor.status
      });

      // Collect all payments (deduplicate if needed)
      receipt.allPayments.push(...debtor.payments);
    }

    // Convert map to array and determine overall status for each receipt
    let groupedDebtors = Array.from(receiptMap.values()).map(receipt => {
      // Determine overall status for the receipt
      let overallStatus = 'PAID';

      if (receipt.amountDue > 0) {
        const now = new Date();
        const isOverdue = receipt.dueDate && new Date(receipt.dueDate) < now;

        if (isOverdue) {
          overallStatus = 'OVERDUE';
        } else if (receipt.amountPaid > 0) {
          overallStatus = 'PARTIAL';
        } else {
          overallStatus = 'OUTSTANDING';
        }
      }

      receipt.status = overallStatus;

      // Deduplicate and sort payments
      const paymentMap = new Map();
      receipt.allPayments.forEach(payment => {
        if (!paymentMap.has(payment.id)) {
          paymentMap.set(payment.id, payment);
        }
      });

      receipt.allPayments = Array.from(paymentMap.values())
        .sort((a, b) => new Date(b.paymentDate).getTime() - new Date(a.paymentDate).getTime())
        .map(payment => ({
          id: payment.id,
          amount: parseFloat(payment.amount),
          paymentMethod: payment.paymentMethod,
          paymentDate: payment.paymentDate,
          referenceNumber: payment.referenceNumber,
          notes: payment.notes
        }));

      receipt.paymentCount = receipt.allPayments.length;
      receipt.lastPaymentDate = receipt.allPayments.length > 0 ? receipt.allPayments[0].paymentDate : null;
      receipt.productCount = receipt.products.length;

      return receipt;
    });

    // Apply status filter if needed
    if (status !== 'all') {
      groupedDebtors = groupedDebtors.filter(receipt => receipt.status === status);
    }

    // Sort by status and date
    groupedDebtors.sort((a, b) => {
      const statusOrder = { OVERDUE: 0, OUTSTANDING: 1, PARTIAL: 2, PAID: 3 };
      const statusDiff = statusOrder[a.status] - statusOrder[b.status];
      if (statusDiff !== 0) return statusDiff;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    // Apply pagination
    const total = groupedDebtors.length;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const paginatedDebtors = groupedDebtors.slice(skip, skip + parseInt(limit));

    // Calculate analytics
    const analyticsData = await prisma.debtor.groupBy({
      by: ['status'],
      where,
      _sum: {
        totalAmount: true,
        amountPaid: true,
        amountDue: true
      },
      _count: true
    });

    const summary = analyticsData.reduce((acc, item) => {
      acc[item.status] = {
        count: item._count,
        totalAmount: item._sum.totalAmount || 0,
        amountPaid: item._sum.amountPaid || 0,
        amountDue: item._sum.amountDue || 0
      };
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        debtors: paginatedDebtors,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        },
        analytics: summary
      }
    });
  })
);

// ================================
// GET CUSTOMER DEBT SUMMARY
// ================================
router.get('/customer/:customerId/summary',
  authorizeModule('warehouse', 'read'),
  asyncHandler(async (req, res) => {
    const { customerId } = req.params;

    const [customer, debtors, totalStats] = await Promise.all([
      prisma.warehouseCustomer.findUnique({
        where: { id: customerId },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          totalCreditPurchases: true,
          totalCreditAmount: true,
          outstandingDebt: true,
          paymentReliabilityScore: true,
          lastPaymentDate: true
        }
      }),

      prisma.debtor.findMany({
        where: { warehouseCustomerId: customerId },
        include: {
          sale: {
            select: {
              receiptNumber: true,
              totalAmount: true
            }
          },
          payments: true
        },
        orderBy: { createdAt: 'desc' }
      }),

      prisma.debtor.aggregate({
        where: { warehouseCustomerId: customerId },
        _sum: {
          totalAmount: true,
          amountPaid: true,
          amountDue: true
        }
      })
    ]);

    if (!customer) {
      return res.status(404).json({
        success: false,
        error: 'Customer not found'
      });
    }

    const overdueDebts = debtors.filter(d => 
      d.status === 'OVERDUE' && d.amountDue > 0
    );

    res.json({
      success: true,
      data: {
        customer,
        summary: {
          totalDebt: totalStats._sum.totalAmount || 0,
          totalPaid: totalStats._sum.amountPaid || 0,
          outstandingAmount: totalStats._sum.amountDue || 0,
          numberOfDebts: debtors.length,
          overdueCount: overdueDebts.length,
          overdueAmount: overdueDebts.reduce((sum, d) => sum + parseFloat(d.amountDue), 0)
        },
        debtors
      }
    });
  })
);

// ================================
// RECORD DEBT PAYMENT
// ================================
router.post('/:debtorId/payments',
  authorizeModule('warehouse', 'write'),
  [
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
    body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
    body('paymentDate').isISO8601(),
    body('referenceNumber').optional().trim(),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { debtorId } = req.params;
    const { amount, paymentMethod, paymentDate, referenceNumber, notes } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      // Get debtor with customer and sale info
      const debtor = await tx.debtor.findUnique({
        where: { id: debtorId },
        include: { 
          warehouseCustomer: true,
          sale: {
            include: {
              product: true
            }
          }
        }
      });

      if (!debtor) {
        throw new ValidationError('Debtor record not found');
      }

      const paymentAmount = parseFloat(amount);
      const currentDue = parseFloat(debtor.amountDue);

      if (paymentAmount > currentDue) {
        throw new ValidationError(
          `Payment amount (₦${paymentAmount.toLocaleString()}) cannot exceed outstanding balance (₦${currentDue.toLocaleString()})`
        );
      }

      // 1. Create payment record
      const payment = await tx.debtorPayment.create({
        data: {
          debtorId,
          amount: paymentAmount,
          paymentMethod,
          paymentDate: new Date(paymentDate),
          referenceNumber,
          notes,
          receivedBy: req.user.id
        }
      });

      // 2. Update debtor record
      const newAmountPaid = parseFloat(debtor.amountPaid) + paymentAmount;
      const newAmountDue = parseFloat(debtor.totalAmount) - newAmountPaid;

      let newStatus = debtor.status;
      if (newAmountDue <= 0) {
        newStatus = 'PAID';
      } else if (newAmountPaid > 0) {
        newStatus = 'PARTIAL';
      }

      const updatedDebtor = await tx.debtor.update({
        where: { id: debtorId },
        data: {
          amountPaid: newAmountPaid,
          amountDue: newAmountDue,
          status: newStatus
        }
      });

      // 3. ✅ UPDATE WAREHOUSE SALE PAYMENT STATUS (FIX ADDED HERE)
      await tx.warehouseSale.update({
        where: { id: debtor.saleId },
        data: {
          paymentStatus: newStatus === 'PAID' ? 'PAID' : 'PARTIAL'
        }
      });

      console.log('✅ Warehouse sale payment status updated:', {
        saleId: debtor.saleId,
        receiptNumber: debtor.sale.receiptNumber,
        newPaymentStatus: newStatus === 'PAID' ? 'PAID' : 'PARTIAL',
        debtorStatus: newStatus
      });

      // 4. CREATE CASH FLOW ENTRY (INFLOW)
      const cashFlowDescription = `Debt payment from ${debtor.warehouseCustomer.name} - ${debtor.sale.product.name} (Receipt: ${debtor.sale.receiptNumber})`;
      
      const cashFlowEntry = await tx.cashFlow.create({
        data: {
          transactionType: 'CASH_IN',
          amount: paymentAmount,
          paymentMethod: paymentMethod,
          description: cashFlowDescription,
          referenceNumber: referenceNumber || `DEBT-PAY-${payment.id.slice(-8)}`,
          cashier: req.user.id,
          module: 'WAREHOUSE'
        }
      });

      console.log('✅ Cash flow entry created for debt payment:', {
        transactionType: 'CASH_IN',
        amount: paymentAmount,
        paymentMethod,
        debtorId,
        cashFlowId: cashFlowEntry.id
      });

      // 5. Update customer stats
      const totalOutstanding = await tx.debtor.aggregate({
        where: {
          warehouseCustomerId: debtor.warehouseCustomerId,
          status: { in: ['OUTSTANDING', 'PARTIAL', 'OVERDUE'] }
        },
        _sum: { amountDue: true }
      });

      // Calculate payment reliability
      const allPayments = await tx.debtorPayment.count({
        where: {
          debtor: { warehouseCustomerId: debtor.warehouseCustomerId }
        }
      });

      const latePayments = await tx.debtorPayment.count({
        where: {
          debtor: {
            warehouseCustomerId: debtor.warehouseCustomerId,
            dueDate: { not: null }
          },
          paymentDate: { gt: debtor.dueDate }
        }
      });

      const reliabilityScore = allPayments > 0
        ? ((allPayments - latePayments) / allPayments) * 100
        : 100;

      await tx.warehouseCustomer.update({
        where: { id: debtor.warehouseCustomerId },
        data: {
          outstandingDebt: totalOutstanding._sum.amountDue || 0,
          lastPaymentDate: new Date(paymentDate),
          paymentReliabilityScore: reliabilityScore
        }
      });

      return { payment, debtor: updatedDebtor, cashFlowEntry };
    });

    res.json({
      success: true,
      message: 'Payment recorded successfully and cash flow updated',
      data: {
        payment: result.payment,
        debtor: result.debtor,
        cashFlowRecorded: true,
        cashFlowId: result.cashFlowEntry.id
      }
    });
  })
);

// ================================
// RECORD PAYMENT FOR RECEIPT (ALL PRODUCTS)
// ================================
router.post('/receipt/:receiptNumber/payment',
  authorizeModule('warehouse', 'write'),
  [
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
    body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
    body('paymentDate').isISO8601(),
    body('referenceNumber').optional().trim(),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.error('❌ Receipt payment validation failed:', {
        receiptNumber: req.params.receiptNumber,
        body: req.body,
        errors: errors.array()
      });
      return res.status(400).json({
        success: false,
        error: 'Validation Error',
        message: 'Invalid payment data',
        details: errors.array()
      });
    }

    const { receiptNumber } = req.params;
    const { amount, paymentMethod, paymentDate, referenceNumber, notes } = req.body;

    console.log('✅ Receipt payment validation passed:', {
      receiptNumber,
      amount,
      paymentMethod,
      paymentDate
    });

    const result = await prisma.$transaction(async (tx) => {
      // Get all debtors for this receipt
      const receiptDebtors = await tx.debtor.findMany({
        where: {
          sale: {
            receiptNumber: receiptNumber
          },
          status: { in: ['OUTSTANDING', 'PARTIAL', 'OVERDUE'] },
          amountDue: { gt: 0 }
        },
        include: {
          warehouseCustomer: true,
          sale: {
            include: {
              product: true
            }
          }
        },
        orderBy: [
          { createdAt: 'asc' }
        ]
      });

      if (receiptDebtors.length === 0) {
        throw new ValidationError(`No outstanding debts found for receipt: ${receiptNumber}`);
      }

      const paymentAmount = parseFloat(amount);
      const totalOutstanding = receiptDebtors.reduce((sum, debt) => sum + parseFloat(debt.amountDue), 0);

      if (paymentAmount > totalOutstanding) {
        throw new ValidationError(
          `Payment amount (₦${paymentAmount.toLocaleString()}) cannot exceed total outstanding balance (₦${totalOutstanding.toLocaleString()})`
        );
      }

      let remainingPayment = paymentAmount;
      const paymentsCreated = [];
      const debtorsUpdated = [];
      const salesUpdated = [];

      // Distribute payment across debts (FIFO - oldest first)
      for (const debt of receiptDebtors) {
        if (remainingPayment <= 0) break;

        const debtDue = parseFloat(debt.amountDue);
        const paymentForThisDebt = Math.min(remainingPayment, debtDue);

        // 1. Create payment record for this debt
        const payment = await tx.debtorPayment.create({
          data: {
            debtorId: debt.id,
            amount: paymentForThisDebt,
            paymentMethod,
            paymentDate: new Date(paymentDate),
            referenceNumber: referenceNumber ? `${referenceNumber}-${debt.id.slice(-4)}` : undefined,
            notes: notes || `Payment allocation: ₦${paymentForThisDebt.toLocaleString()}`,
            receivedBy: req.user.id
          }
        });

        paymentsCreated.push(payment);

        // 2. Update debtor record
        const newAmountPaid = parseFloat(debt.amountPaid) + paymentForThisDebt;
        const newAmountDue = parseFloat(debt.totalAmount) - newAmountPaid;

        let newStatus = debt.status;
        if (newAmountDue <= 0) {
          newStatus = 'PAID';
        } else if (newAmountPaid > 0) {
          newStatus = 'PARTIAL';
        }

        const updatedDebtor = await tx.debtor.update({
          where: { id: debt.id },
          data: {
            amountPaid: newAmountPaid,
            amountDue: newAmountDue,
            status: newStatus
          }
        });

        debtorsUpdated.push(updatedDebtor);

        // 3. Update warehouse sale payment status
        await tx.warehouseSale.update({
          where: { id: debt.saleId },
          data: {
            paymentStatus: newStatus === 'PAID' ? 'PAID' : 'PARTIAL'
          }
        });

        salesUpdated.push(debt.saleId);

        remainingPayment -= paymentForThisDebt;
      }

      // 4. Create single cash flow entry for the entire payment
      const customer = receiptDebtors[0].warehouseCustomer;
      const cashFlowDescription = `Debt payment from ${customer.name} - Receipt: ${receiptNumber} (${debtorsUpdated.length} product${debtorsUpdated.length > 1 ? 's' : ''})`;

      const cashFlowEntry = await tx.cashFlow.create({
        data: {
          transactionType: 'CASH_IN',
          amount: paymentAmount,
          paymentMethod: paymentMethod,
          description: cashFlowDescription,
          referenceNumber: referenceNumber || `DEBT-PAY-${receiptNumber}`,
          cashier: req.user.id,
          module: 'WAREHOUSE'
        }
      });

      console.log('✅ Receipt debt payment processed:', {
        receiptNumber,
        customerName: customer.name,
        totalPayment: paymentAmount,
        debtsUpdated: debtorsUpdated.length,
        salesUpdated: salesUpdated.length,
        cashFlowId: cashFlowEntry.id
      });

      // 5. Update customer stats
      const customerId = receiptDebtors[0].warehouseCustomerId;
      const totalOutstandingAfter = await tx.debtor.aggregate({
        where: {
          warehouseCustomerId: customerId,
          status: { in: ['OUTSTANDING', 'PARTIAL', 'OVERDUE'] }
        },
        _sum: { amountDue: true }
      });

      // Calculate payment reliability
      const allPayments = await tx.debtorPayment.count({
        where: {
          debtor: { warehouseCustomerId: customerId }
        }
      });

      const latePayments = await tx.debtorPayment.count({
        where: {
          debtor: {
            warehouseCustomerId: customerId,
            dueDate: { not: null }
          },
          paymentDate: { gt: prisma.debtor.fields.dueDate }
        }
      });

      const reliabilityScore = allPayments > 0
        ? ((allPayments - latePayments) / allPayments) * 100
        : 100;

      await tx.warehouseCustomer.update({
        where: { id: customerId },
        data: {
          outstandingDebt: totalOutstandingAfter._sum.amountDue || 0,
          lastPaymentDate: new Date(paymentDate),
          paymentReliabilityScore: reliabilityScore
        }
      });

      return {
        payments: paymentsCreated,
        debtorsUpdated,
        salesUpdated,
        cashFlowEntry,
        receiptNumber,
        paymentAllocation: debtorsUpdated.map(d => ({
          debtId: d.id,
          amountAllocated: paymentsCreated.find(p => p.debtorId === d.id)?.amount || 0,
          newStatus: d.status
        }))
      };
    });

    res.json({
      success: true,
      message: `Payment of ₦${parseFloat(amount).toLocaleString()} recorded successfully for receipt ${receiptNumber}`,
      data: {
        receiptNumber: result.receiptNumber,
        totalPayment: parseFloat(amount),
        debtsUpdated: result.debtorsUpdated.length,
        salesUpdated: result.salesUpdated.length,
        paymentAllocation: result.paymentAllocation,
        cashFlowRecorded: true,
        cashFlowId: result.cashFlowEntry.id
      }
    });
  })
);

// ================================
// RECORD PAYMENT FOR CUSTOMER (ALL DEBTS)
// ================================
router.post('/customer/:customerId/payment',
  authorizeModule('warehouse', 'write'),
  [
    body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
    body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
    body('paymentDate').isISO8601(),
    body('referenceNumber').optional().trim(),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { customerId } = req.params;
    const { amount, paymentMethod, paymentDate, referenceNumber, notes } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      // Get all outstanding debts for this customer
      const customerDebts = await tx.debtor.findMany({
        where: {
          warehouseCustomerId: customerId,
          status: { in: ['OUTSTANDING', 'PARTIAL', 'OVERDUE'] },
          amountDue: { gt: 0 }
        },
        include: {
          warehouseCustomer: true,
          sale: {
            include: {
              product: true
            }
          }
        },
        orderBy: [
          { dueDate: 'asc' }, // Prioritize older debts
          { createdAt: 'asc' }
        ]
      });

      if (customerDebts.length === 0) {
        throw new ValidationError('No outstanding debts found for this customer');
      }

      const paymentAmount = parseFloat(amount);
      const totalOutstanding = customerDebts.reduce((sum, debt) => sum + parseFloat(debt.amountDue), 0);

      if (paymentAmount > totalOutstanding) {
        throw new ValidationError(
          `Payment amount (₦${paymentAmount.toLocaleString()}) cannot exceed total outstanding balance (₦${totalOutstanding.toLocaleString()})`
        );
      }

      let remainingPayment = paymentAmount;
      const paymentsCreated = [];
      const debtorsUpdated = [];
      const salesUpdated = [];

      // Distribute payment across debts (FIFO - oldest first)
      for (const debt of customerDebts) {
        if (remainingPayment <= 0) break;

        const debtDue = parseFloat(debt.amountDue);
        const paymentForThisDebt = Math.min(remainingPayment, debtDue);

        // 1. Create payment record for this debt
        const payment = await tx.debtorPayment.create({
          data: {
            debtorId: debt.id,
            amount: paymentForThisDebt,
            paymentMethod,
            paymentDate: new Date(paymentDate),
            referenceNumber: referenceNumber ? `${referenceNumber}-${debt.id.slice(-4)}` : undefined,
            notes: notes || `Payment allocation: ₦${paymentForThisDebt.toLocaleString()}`,
            receivedBy: req.user.id
          }
        });

        paymentsCreated.push(payment);

        // 2. Update debtor record
        const newAmountPaid = parseFloat(debt.amountPaid) + paymentForThisDebt;
        const newAmountDue = parseFloat(debt.totalAmount) - newAmountPaid;

        let newStatus = debt.status;
        if (newAmountDue <= 0) {
          newStatus = 'PAID';
        } else if (newAmountPaid > 0) {
          newStatus = 'PARTIAL';
        }

        const updatedDebtor = await tx.debtor.update({
          where: { id: debt.id },
          data: {
            amountPaid: newAmountPaid,
            amountDue: newAmountDue,
            status: newStatus
          }
        });

        debtorsUpdated.push(updatedDebtor);

        // 3. Update warehouse sale payment status
        await tx.warehouseSale.update({
          where: { id: debt.saleId },
          data: {
            paymentStatus: newStatus === 'PAID' ? 'PAID' : 'PARTIAL'
          }
        });

        salesUpdated.push(debt.saleId);

        remainingPayment -= paymentForThisDebt;
      }

      // 4. Create single cash flow entry for the entire payment
      const customer = customerDebts[0].warehouseCustomer;
      const cashFlowDescription = `Debt payment from ${customer.name} - Allocated across ${debtorsUpdated.length} debt(s)`;
      
      const cashFlowEntry = await tx.cashFlow.create({
        data: {
          transactionType: 'CASH_IN',
          amount: paymentAmount,
          paymentMethod: paymentMethod,
          description: cashFlowDescription,
          referenceNumber: referenceNumber || `DEBT-PAY-${Date.now()}`,
          cashier: req.user.id,
          module: 'WAREHOUSE'
        }
      });

      console.log('✅ Customer debt payment processed:', {
        customerId,
        customerName: customer.name,
        totalPayment: paymentAmount,
        debtsUpdated: debtorsUpdated.length,
        salesUpdated: salesUpdated.length,
        cashFlowId: cashFlowEntry.id
      });

      // 5. Update customer stats
      const totalOutstandingAfter = await tx.debtor.aggregate({
        where: {
          warehouseCustomerId: customerId,
          status: { in: ['OUTSTANDING', 'PARTIAL', 'OVERDUE'] }
        },
        _sum: { amountDue: true }
      });

      // Calculate payment reliability
      const allPayments = await tx.debtorPayment.count({
        where: {
          debtor: { warehouseCustomerId: customerId }
        }
      });

      const latePayments = await tx.debtorPayment.count({
        where: {
          debtor: {
            warehouseCustomerId: customerId,
            dueDate: { not: null }
          },
          paymentDate: { gt: prisma.debtor.fields.dueDate }
        }
      });

      const reliabilityScore = allPayments > 0
        ? ((allPayments - latePayments) / allPayments) * 100
        : 100;

      await tx.warehouseCustomer.update({
        where: { id: customerId },
        data: {
          outstandingDebt: totalOutstandingAfter._sum.amountDue || 0,
          lastPaymentDate: new Date(paymentDate),
          paymentReliabilityScore: reliabilityScore
        }
      });

      return {
        payments: paymentsCreated,
        debtorsUpdated,
        salesUpdated,
        cashFlowEntry,
        paymentAllocation: debtorsUpdated.map(d => ({
          debtId: d.id,
          amountAllocated: paymentsCreated.find(p => p.debtorId === d.id)?.amount || 0,
          newStatus: d.status
        }))
      };
    });

    res.json({
      success: true,
      message: `Payment of ₦${parseFloat(amount).toLocaleString()} recorded successfully`,
      data: {
        totalPayment: parseFloat(amount),
        debtsUpdated: result.debtorsUpdated.length,
        salesUpdated: result.salesUpdated.length,
        paymentAllocation: result.paymentAllocation,
        cashFlowRecorded: true,
        cashFlowId: result.cashFlowEntry.id
      }
    });
  })
);

// ================================
// GET DEBTORS ANALYTICS
// ================================
router.get('/analytics',
  authorizeModule('warehouse', 'read'),
  [
    query('period').optional().isIn(['day', 'week', 'month', 'year']),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const { period = 'month', startDate, endDate } = req.query;

    const where = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const [
      totalDebtors,
      statusBreakdown,
      topDebtors,
      paymentTrends,
      agingAnalysis
    ] = await Promise.all([
      // Total statistics
      prisma.debtor.aggregate({
        where,
        _sum: {
          totalAmount: true,
          amountPaid: true,
          amountDue: true
        },
        _count: true
      }),

      // Status breakdown
      prisma.debtor.groupBy({
        by: ['status'],
        where,
        _sum: {
          totalAmount: true,
          amountDue: true
        },
        _count: true
      }),

      // Top debtors
      prisma.debtor.findMany({
        where: {
          ...where,
          status: { in: ['OUTSTANDING', 'PARTIAL', 'OVERDUE'] }
        },
        include: {
          warehouseCustomer: {
            select: {
              name: true,
              phone: true,
              paymentReliabilityScore: true
            }
          }
        },
        orderBy: {
          amountDue: 'desc'
        },
        take: 10
      }),

      // Payment trends (last 12 months)
      prisma.$queryRaw`
        SELECT 
          DATE_TRUNC('month', payment_date) as month,
          COUNT(*) as payment_count,
          SUM(amount) as total_amount
        FROM warehouse_debtor_payments
        WHERE payment_date >= NOW() - INTERVAL '12 months'
        GROUP BY DATE_TRUNC('month', payment_date)
        ORDER BY month DESC
      `,

      // Aging analysis
      prisma.$queryRaw`
        SELECT 
          CASE 
            WHEN due_date IS NULL THEN 'No Due Date'
            WHEN due_date >= CURRENT_DATE THEN 'Current'
            WHEN due_date >= CURRENT_DATE - INTERVAL '30 days' THEN '1-30 Days'
            WHEN due_date >= CURRENT_DATE - INTERVAL '60 days' THEN '31-60 Days'
            WHEN due_date >= CURRENT_DATE - INTERVAL '90 days' THEN '61-90 Days'
            ELSE '90+ Days'
          END as age_bracket,
          COUNT(*) as count,
          SUM(amount_due) as total_due
        FROM warehouse_debtors
        WHERE status IN ('OUTSTANDING', 'PARTIAL', 'OVERDUE')
        GROUP BY age_bracket
        ORDER BY 
          CASE age_bracket
            WHEN 'Current' THEN 1
            WHEN '1-30 Days' THEN 2
            WHEN '31-60 Days' THEN 3
            WHEN '61-90 Days' THEN 4
            WHEN '90+ Days' THEN 5
            ELSE 6
          END
      `
    ]);

    res.json({
      success: true,
      data: {
        summary: {
          totalDebtors: totalDebtors._count,
          totalAmount: totalDebtors._sum.totalAmount || 0,
          totalPaid: totalDebtors._sum.amountPaid || 0,
          totalOutstanding: totalDebtors._sum.amountDue || 0
        },
        statusBreakdown,
        topDebtors,
        paymentTrends,
        agingAnalysis
      }
    });
  })
);

module.exports = router;