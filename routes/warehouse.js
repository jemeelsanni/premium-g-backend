const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const PDFDocument = require('pdfkit');
const { Parser } = require('json2csv');

const { asyncHandler, ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

const warehouseCustomersRouter = require('./warehouse-customers');
router.use('/', warehouseCustomersRouter);

// Include expense management routes
const warehouseExpensesRouter = require('./warehouse-expenses');
router.use('/', warehouseExpensesRouter);

const warehousePurchasesRouter = require('./warehouse-purchases');
router.use('/purchases', warehousePurchasesRouter);

const warehouseDebtorsRouter = require('./warehouse-debtors');
router.use('/', warehouseDebtorsRouter);


// Include discount management routes (if created)
let checkCustomerDiscount;
try {
  const warehouseDiscountsModule = require('./warehouse-discounts');
  
  console.log('🔍 Warehouse discounts module structure:', {
    hasRouter: !!warehouseDiscountsModule.router,
    hasCheckFunction: !!warehouseDiscountsModule.checkCustomerDiscount,
    isFunction: typeof warehouseDiscountsModule.checkCustomerDiscount === 'function'
  });
  
  // Check if it's exported as an object with router and function
  if (warehouseDiscountsModule.router && warehouseDiscountsModule.checkCustomerDiscount) {
    router.use('/', warehouseDiscountsModule.router);
    checkCustomerDiscount = warehouseDiscountsModule.checkCustomerDiscount;
    console.log('✅ Warehouse discounts router and function loaded successfully');
  } else if (warehouseDiscountsModule.checkCustomerDiscount) {
    // Has function but no router property
    checkCustomerDiscount = warehouseDiscountsModule.checkCustomerDiscount;
    if (typeof warehouseDiscountsModule === 'function') {
      router.use('/', warehouseDiscountsModule);
    }
    console.log('✅ Warehouse discounts function loaded successfully');
  } else {
    // Fallback - assume it's just a router
    router.use('/', warehouseDiscountsModule);
    console.log('⚠️  checkCustomerDiscount function not found, using fallback');
    checkCustomerDiscount = async () => ({
      hasDiscount: false,
      originalPrice: 0,
      finalPrice: 0,
      discountAmount: 0,
      discountPercentage: 0
    });
  }
} catch (error) {
  console.log('⚠️  Warehouse discounts router not found, skipping...', error.message);
  // Fallback checkCustomerDiscount function
  checkCustomerDiscount = async () => ({
    hasDiscount: false,
    originalPrice: 0,
    finalPrice: 0,
    discountAmount: 0,
    discountPercentage: 0
  });
}


// ================================
// VALIDATION RULES
// ================================

const createWarehouseSaleValidation = [
  body('productId').custom(validateCuid('product ID')),
  body('quantity').isInt({ min: 1 }).withMessage('Quantity must be a positive integer'),
  body('unitType').isIn(['PALLETS', 'PACKS', 'UNITS']).withMessage('Invalid unit type'),
  body('unitPrice').isDecimal({ decimal_digits: '0,2' }).withMessage('Valid unit price required'),
  body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']).withMessage('Invalid payment method'),
  body('customerName').optional().isLength({ max: 200 }),
  body('customerPhone').optional().isLength({ max: 20 })
];

const createCashFlowValidation = [
  body('transactionType').isIn(['CASH_IN', 'CASH_OUT', 'SALE', 'EXPENSE', 'ADJUSTMENT']).withMessage('Invalid transaction type'),
  body('amount').isDecimal({ decimal_digits: '0,2' }).withMessage('Valid amount required'),
  body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']).withMessage('Invalid payment method'),
  body('description').optional().isLength({ max: 500 }),
  body('referenceNumber').optional().isLength({ max: 50 })
];

const updateInventoryValidation = [
  body('pallets').optional().isInt({ min: 0 }),
  body('packs').optional().isInt({ min: 0 }),
  body('units').optional().isInt({ min: 0 }),
  body('reorderLevel').optional().isInt({ min: 0 }),
  body('maxStockLevel').optional().isInt({ min: 0 }),
  body('location').optional().isLength({ max: 100 })
];

// ================================
// UTILITY FUNCTIONS
// ================================

const isReceiptNumberConflict = (error) => {
  if (!error || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes('receipt_number');
  }
  if (typeof target === 'string') {
    return target.includes('receipt_number');
  }
  return false;
};

const dropReceiptNumberConstraintIfExists = async () => {
  try {
    await prisma.$executeRaw`DROP INDEX IF EXISTS "warehouse_sales_receipt_number_key"`;
  } catch (dropError) {
    console.error('Failed to drop receipt number unique index', dropError);
  }
};

const withReceiptConflictRetry = async (operation) => {
  try {
    return await operation();
  } catch (error) {
    if (isReceiptNumberConflict(error)) {
      await dropReceiptNumberConstraintIfExists();
      return operation();
    }
    throw error;
  }
};

const generateReceiptNumber = async () => {
  const prefix = 'WHS';
  const date = new Date();
  const dateStr = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  
  const lastReceipt = await prisma.warehouseSale.findFirst({
    where: {
      receiptNumber: { startsWith: `${prefix}-${dateStr}` }
    },
    orderBy: { createdAt: 'desc' }
  });

  let sequence = 1;
  if (lastReceipt) {
    const lastSequence = parseInt(lastReceipt.receiptNumber.split('-')[2]);
    sequence = lastSequence + 1;
  }

  return `${prefix}-${dateStr}-${String(sequence).padStart(4, '0')}`;
};

const updateInventoryAfterSale = async (productId, quantity, unitType, tx) => {
  const inventory = await tx.warehouseInventory.findFirst({
    where: { productId }
  });

  if (!inventory) {
    throw new BusinessError('Product not found in inventory', 'PRODUCT_NOT_FOUND');
  }

  const updateData = {};
  
  switch (unitType) {
    case 'PALLETS':
      if (inventory.pallets < quantity) {
        throw new BusinessError('Insufficient pallets in inventory', 'INSUFFICIENT_STOCK');
      }
      updateData.pallets = inventory.pallets - quantity;
      break;
    case 'PACKS':
      if (inventory.packs < quantity) {
        throw new BusinessError('Insufficient packs in inventory', 'INSUFFICIENT_STOCK');
      }
      updateData.packs = inventory.packs - quantity;
      break;
    case 'UNITS':
      if (inventory.units < quantity) {
        throw new BusinessError('Insufficient units in inventory', 'INSUFFICIENT_STOCK');
      }
      updateData.units = inventory.units - quantity;
      break;
  }

  await tx.warehouseInventory.update({
    where: { id: inventory.id },
    data: updateData
  });
};


router.use('/', warehouseCustomersRouter);

// ================================
// INVENTORY ROUTES
// ================================

// @route   GET /api/v1/warehouse/inventory
// @desc    Get warehouse inventory with filtering
// @access  Private (Warehouse module access)
router.get('/inventory', asyncHandler(async (req, res) => {
  const { productId, location, lowStock } = req.query;

  const where = {};

  if (productId) where.productId = productId;
  if (location) where.location = location;
  
  // Low stock filter
  if (lowStock === 'true') {
    where.packs = { lte: prisma.raw('reorder_level') };
  }

  const inventory = await prisma.warehouseInventory.findMany({
    where,
    include: {
      product: true
    },
    orderBy: { lastUpdated: 'desc' }
  });

  res.json({
    success: true,
    data: inventory 
  });
}));

// @route   PUT /api/v1/warehouse/inventory/:id
// @desc    Update inventory levels
// @access  Private (Warehouse Admin)
router.put('/inventory/:id',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  param('id').custom(validateCuid('inventory ID')),
  [
    body('pallets').optional().isInt({ min: 0 }),
    body('packs').optional().isInt({ min: 0 }),
    body('units').optional().isInt({ min: 0 }),
    body('reorderLevel').optional().isInt({ min: 0 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;

    const inventory = await prisma.warehouseInventory.update({
      where: { id },
      data: updateData,
      include: {
        product: true
      }
    });

    res.json({
      success: true,
      message: 'Inventory updated successfully',
      data: { inventory }
    });
  })
);

// @route   GET /api/v1/warehouse/products
// @desc    Get products available for warehouse
// @access  Private (Warehouse module access)
// Add this to routes/warehouse.js
router.get('/products', asyncHandler(async (req, res) => {
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      module: 'WAREHOUSE'
    },
    orderBy: { name: 'asc' }
  });

  res.json({
    success: true,
    data: { products }
  });
}));

// ================================
// WAREHOUSE SALES ROUTES
// ================================



// @route   POST /api/v1/warehouse/sales
// @desc    Create warehouse sale with automatic discount application
// @access  Private (Warehouse Sales Officer, Admin)
router.post(
  '/sales',
  authorizeModule('warehouse', 'write'),
  [
    body('productId').custom(validateCuid('product ID')),
    body('quantity').isInt({ min: 1 }).withMessage('Quantity must be greater than 0'),
    body('unitType').isIn(['PALLETS', 'PACKS', 'UNITS']).withMessage('Invalid unit type'),
    body('unitPrice').isFloat({ min: 0 }).withMessage('Unit price must be 0 or greater'),
    body('paymentMethod').optional().isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
    body('paymentStatus').optional().isIn(['PAID', 'CREDIT', 'PARTIAL']),
    body('creditDueDate').optional().isISO8601(),
    body('creditNotes').optional().trim(),
    body('warehouseCustomerId').optional().custom(validateCuid('warehouse customer ID')),
    body('customerName').optional().trim(),
    body('customerPhone').optional().trim(),
    body('amountPaid').optional().isFloat({ min: 0 }),
    body('initialPaymentMethod').optional().isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
  ],
  asyncHandler(async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      productId,
      quantity,
      unitType,
      unitPrice,
      paymentMethod,
      paymentStatus,
      creditDueDate,
      creditNotes,
      warehouseCustomerId,
      customerName,
      customerPhone,
      receiptNumber: providedReceiptNumber,
      amountPaid: providedAmountPaid,
      initialPaymentMethod
    } = req.body;

    console.log('📥 RAW INPUT:', { providedAmountPaid, paymentMethod, initialPaymentMethod });

    // ============================================================================
    // 🔥 FIX: Prevent Auto-Multiplication of Partial Amount
    // ============================================================================
    let amountPaid = 0;
    const isCreditSale = paymentStatus === 'CREDIT' || paymentMethod === 'CREDIT';

    if (isCreditSale && providedAmountPaid) {
      const cleanedAmount = String(providedAmountPaid)
        .replace(/[₦,\s]/g, '')
        .replace(/,/g, '');
      amountPaid = parseFloat(cleanedAmount);
      if (isNaN(amountPaid) || amountPaid < 0) {
        throw new ValidationError('Invalid partial payment amount');
      }
    }

    console.log('✅ CLEANED amountPaid:', amountPaid);

    // ============================================================================
    // CUSTOMER VALIDATION
    // ============================================================================
    let customerId = warehouseCustomerId;

    if (isCreditSale && !customerId && !customerName) {
      throw new ValidationError('Customer information is required for credit sales.');
    }

    // Create or find customer
    if (!customerId && customerName) {
      let existingCustomer = await prisma.warehouseCustomer.findFirst({
        where: { name: customerName, phone: customerPhone || null }
      });
      if (!existingCustomer) {
        existingCustomer = await prisma.warehouseCustomer.create({
          data: {
            name: customerName,
            phone: customerPhone,
            customerType: 'INDIVIDUAL',
            createdBy: req.user.id
          }
        });
      }
      customerId = existingCustomer.id;
    }

    // ============================================================================
    // PRODUCT VALIDATION AND PRICE RANGE ENFORCEMENT
    // ============================================================================
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        name: true,
        costPerPack: true,
        pricePerPack: true,
        minSellingPrice: true,
        maxSellingPrice: true,
        packsPerPallet: true
      }
    });

    if (!product) throw new NotFoundError('Product not found');

    const price = parseFloat(unitPrice);
    if (product.minSellingPrice !== null) {
      const minPrice = parseFloat(product.minSellingPrice);
      if (price < minPrice) {
        throw new ValidationError(
          `Unit price (₦${price}) is below minimum selling price (₦${minPrice}) for ${product.name}`
        );
      }
    }
    if (product.maxSellingPrice !== null) {
      const maxPrice = parseFloat(product.maxSellingPrice);
      if (price > maxPrice) {
        throw new ValidationError(
          `Unit price (₦${price}) exceeds maximum selling price (₦${maxPrice}) for ${product.name}`
        );
      }
    }

    // ============================================================================
    // CALCULATE TOTALS AND PROFITS
    // ============================================================================
    const totalAmount = parseFloat((price * quantity).toFixed(2));
    const costPerUnit = parseFloat(product.costPerPack || 0);
    const totalCost = parseFloat((costPerUnit * quantity).toFixed(2));
    const grossProfit = totalAmount - totalCost;
    const profitMargin = totalAmount > 0 ? (grossProfit / totalAmount) * 100 : 0;

    if (amountPaid > totalAmount) {
      throw new ValidationError(
        `Amount paid (₦${amountPaid}) cannot exceed total amount (₦${totalAmount})`
      );
    }

    if (amountPaid > 0 && !initialPaymentMethod) {
      throw new ValidationError('Payment method is required for partial payment');
    }

    const receiptNumber = providedReceiptNumber || await generateReceiptNumber();
    console.log('💰 PAYMENT SUMMARY:', { totalAmount, amountPaid, balance: totalAmount - amountPaid });

    // ============================================================================
    // CREATE TRANSACTION
    // ============================================================================
    const createSaleOperation = () =>
      prisma.$transaction(async (tx) => {
        // Determine payment status
        let salePaymentStatus = 'PAID';
        if (isCreditSale) {
          if (amountPaid === 0) salePaymentStatus = 'CREDIT';
          else if (amountPaid < totalAmount) salePaymentStatus = 'PARTIAL';
          else salePaymentStatus = 'PAID';
        }

        // Step 1: Create sale
        const warehouseSale = await tx.warehouseSale.create({
          data: {
            productId,
            quantity,
            unitType,
            unitPrice: price,
            totalAmount,
            costPerUnit,
            totalCost,
            grossProfit,
            profitMargin,
            paymentMethod: isCreditSale && amountPaid > 0 ? initialPaymentMethod : paymentMethod,
            warehouseCustomerId: customerId,
            customerName,
            customerPhone,
            receiptNumber,
            salesOfficer: req.user.id,
            paymentStatus: salePaymentStatus,
            creditDueDate: isCreditSale ? new Date(creditDueDate) : null,
            creditNotes: isCreditSale ? creditNotes : null
          }
        });

        // Step 2: Cash Flow
        if (!isCreditSale) {
          await tx.cashFlow.create({
            data: {
              transactionType: 'CASH_IN',
              amount: totalAmount,
              paymentMethod,
              description: `Sale: ${product.name} - ${customerName || 'Walk-in'}`,
              referenceNumber: receiptNumber,
              cashier: req.user.id,
              module: 'WAREHOUSE'
            }
          });
        } else if (isCreditSale && amountPaid > 0) {
          await tx.cashFlow.create({
            data: {
              transactionType: 'CASH_IN',
              amount: amountPaid,
              paymentMethod: initialPaymentMethod,
              description: `Partial payment on credit sale: ${product.name} - ${customerName}`,
              referenceNumber: receiptNumber,
              cashier: req.user.id,
              module: 'WAREHOUSE'
            }
          });
        }

        // Step 3: Debtors update
        if (isCreditSale) {
          const amountDue = parseFloat((totalAmount - amountPaid).toFixed(2));
          let debtorStatus = 'OUTSTANDING';
          if (amountDue === 0) debtorStatus = 'PAID';
          else if (amountPaid > 0) debtorStatus = 'PARTIAL';

          const debtor = await tx.debtor.create({
            data: {
              warehouseCustomerId: customerId,
              saleId: warehouseSale.id,
              totalAmount,
              amountPaid,
              amountDue,
              dueDate: creditDueDate ? new Date(creditDueDate) : null,
              status: debtorStatus
            }
          });

          if (amountPaid > 0) {
            await tx.debtorPayment.create({
              data: {
                debtorId: debtor.id,
                amount: amountPaid,
                paymentMethod: initialPaymentMethod,
                paymentDate: new Date(),
                notes: 'Initial partial payment at sale',
                receivedBy: req.user.id
              }
            });
          }

          await tx.warehouseCustomer.update({
            where: { id: customerId },
            data: {
              totalCreditPurchases: { increment: 1 },
              totalCreditAmount: { increment: totalAmount },
              outstandingDebt: { increment: amountDue },
              lastPaymentDate: amountPaid > 0 ? new Date() : undefined
            }
          });
        }

        // Step 4: Inventory update
        if (unitType === 'PACKS') {
          await tx.warehouseInventory.updateMany({
            where: { productId },
            data: { packs: { decrement: quantity } }
          });
        } else if (unitType === 'PALLETS') {
          await tx.warehouseInventory.updateMany({
            where: { productId },
            data: { pallets: { decrement: quantity } }
          });
        } else if (unitType === 'UNITS') {
          await tx.warehouseInventory.updateMany({
            where: { productId },
            data: { units: { decrement: quantity } }
          });
        }

        // Step 5: Customer stats
        if (customerId) {
          const amountToRecord = isCreditSale ? amountPaid : totalAmount;
          const stats = await tx.warehouseCustomer.update({
            where: { id: customerId },
            data: {
              totalPurchases: { increment: 1 },
              totalSpent: { increment: amountToRecord },
              lastPurchaseDate: new Date()
            },
            select: { totalPurchases: true, totalSpent: true }
          });

          const avgOrderValue =
            stats.totalPurchases > 0
              ? parseFloat((stats.totalSpent / stats.totalPurchases).toFixed(2))
              : 0;

          await tx.warehouseCustomer.update({
            where: { id: customerId },
            data: { averageOrderValue: avgOrderValue }
          });
        }

        console.log('✅✅✅ Transaction completed successfully');
        return { warehouseSale };
      });

    const result = await withReceiptConflictRetry(() => createSaleOperation());

    // ============================================================================
    // SUCCESS MESSAGE
    // ============================================================================
    let message = '';
    const balance = totalAmount - amountPaid;

    if (isCreditSale) {
      message =
        amountPaid > 0
          ? `Credit sale created with partial payment. Paid ₦${amountPaid.toLocaleString()}, Remaining ₦${balance.toLocaleString()}`
          : `Credit sale created successfully. Total ₦${totalAmount.toLocaleString()}, Due ${new Date(
              creditDueDate
            ).toLocaleDateString()}`;
    } else {
      message = `Sale recorded successfully. Total ₦${totalAmount.toLocaleString()}`;
    }

    res.status(201).json({
      success: true,
      message,
      data: result
    });
  })
);


// @route   GET /api/v1/warehouse/sales
// @desc    Get warehouse sales with filtering and pagination
// @access  Private (Warehouse module access)
router.get('/sales',
  authorizeModule('warehouse'),
  [
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('customerId').optional(),
    query('productId').optional(),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const {
      page = '1',
      limit = '10',
      customerId,
      productId,
      startDate,
      endDate
    } = req.query;

    const pageNumber = parseInt(page, 10);
    const pageSize = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageSize;
    const take = pageSize;

    const baseWhere = {};

    if (customerId) {
      baseWhere.warehouseCustomerId = customerId;
    }

    if (startDate || endDate) {
      baseWhere.createdAt = {};
      if (startDate) baseWhere.createdAt.gte = new Date(startDate);
      if (endDate) baseWhere.createdAt.lte = new Date(endDate);
    }

    const groupWhere = { ...baseWhere };
    if (productId) {
      groupWhere.productId = productId;
    }

    const totalGroups = await prisma.warehouseSale.groupBy({
      where: groupWhere,
      by: ['receiptNumber']
    });
    const total = totalGroups.length;

    if (total === 0) {
      return res.json({
        success: true,
        data: {
          sales: [],
          pagination: {
            page: pageNumber,
            limit: pageSize,
            total: 0,
            totalPages: 0
          }
        }
      });
    }

    const groupedReceipts = await prisma.warehouseSale.groupBy({
      where: groupWhere,
      by: ['receiptNumber'],
      orderBy: {
        _max: { createdAt: 'desc' }
      },
      skip,
      take,
      _max: { createdAt: true }
    });

    const receiptNumbers = groupedReceipts.map(group => group.receiptNumber);

    if (receiptNumbers.length === 0) {
      return res.json({
        success: true,
        data: {
          sales: [],
          pagination: {
            page: pageNumber,
            limit: pageSize,
            total,
            totalPages: Math.ceil(total / pageSize)
          }
        }
      });
    }

    const latestCreatedMap = new Map(groupedReceipts.map(group => [group.receiptNumber, group._max.createdAt]));

    const sales = await prisma.warehouseSale.findMany({
      where: {
        ...baseWhere,
        receiptNumber: { in: receiptNumbers }
      },
      include: {
        product: { select: { name: true, productNo: true } },
        warehouseCustomer: { select: { id: true, name: true, phone: true } },
        salesOfficerUser: { select: { id: true, username: true } },
        debtor: {
          select: {
            id: true,
            amountPaid: true,
            amountDue: true,
            status: true,
            dueDate: true
          }
        },
      },
      orderBy: { createdAt: 'asc' }
    });

    const aggregateMap = new Map();

    for (const sale of sales) {
      const key = sale.receiptNumber;
      const aggregate = aggregateMap.get(key) || {
        receiptNumber: key,
        saleIds: [],
        warehouseCustomerId: sale.warehouseCustomerId,
        customerName: sale.customerName || sale.warehouseCustomer?.name || null,
        customerPhone: sale.customerPhone || sale.warehouseCustomer?.phone || null,
        paymentMethod: sale.paymentMethod,
        paymentStatus: sale.paymentStatus,
        creditDueDate: sale.creditDueDate,
        salesOfficer: sale.salesOfficer,
        salesOfficerUser: sale.salesOfficerUser,
        warehouseCustomer: sale.warehouseCustomer,
        totalAmount: 0,
        totalDiscountAmount: 0,
        totalCost: 0,
        grossProfit: 0,
        discountApplied: false,
        discountPercentage: 0,
        discountReason: null,
        createdAt: latestCreatedMap.get(key) || sale.createdAt,
        items: [],
        debtor: null
      };

      aggregate.saleIds.push(sale.id);
      aggregate.totalAmount += Number(sale.totalAmount);
      aggregate.totalDiscountAmount += Number(sale.totalDiscountAmount || 0);
      aggregate.totalCost += Number(sale.totalCost || 0);
      aggregate.grossProfit += Number(sale.grossProfit || 0);
      aggregate.discountApplied = aggregate.discountApplied || sale.discountApplied;

      if (sale.discountPercentage && sale.discountPercentage > (aggregate.discountPercentage || 0)) {
        aggregate.discountPercentage = Number(sale.discountPercentage);
      }

      if (sale.discountReason && !aggregate.discountReason) {
        aggregate.discountReason = sale.discountReason;
      }

      if (!aggregate.customerName) {
        aggregate.customerName = sale.customerName || sale.warehouseCustomer?.name || null;
      }

      if (!aggregate.customerPhone) {
        aggregate.customerPhone = sale.customerPhone || sale.warehouseCustomer?.phone || null;
      }

      if (!aggregate.warehouseCustomer && sale.warehouseCustomer) {
        aggregate.warehouseCustomer = sale.warehouseCustomer;
      }

      // ✅ CRITICAL FIX: Capture debtor info from the first sale that has it
      if (sale.debtor && !aggregate.debtor) {
        aggregate.debtor = {
          id: sale.debtor.id,
          amountPaid: Number(sale.debtor.amountPaid),
          amountDue: Number(sale.debtor.amountDue),
          status: sale.debtor.status,
          dueDate: sale.debtor.dueDate
        };
      }

      aggregate.items.push({
        id: sale.id,
        productId: sale.productId,
        product: sale.product,
        quantity: sale.quantity,
        unitType: sale.unitType,
        unitPrice: Number(sale.unitPrice),
        totalAmount: Number(sale.totalAmount),
        totalDiscountAmount: sale.totalDiscountAmount ? Number(sale.totalDiscountAmount) : 0,
        discountApplied: sale.discountApplied,
        discountPercentage: sale.discountPercentage ? Number(sale.discountPercentage) : null,
        originalUnitPrice: sale.originalUnitPrice ? Number(sale.originalUnitPrice) : null,
        costPerUnit: Number(sale.costPerUnit || 0),
        totalCost: Number(sale.totalCost || 0),
        grossProfit: Number(sale.grossProfit || 0)
      });

      aggregateMap.set(key, aggregate);
    }

    const aggregatedSales = receiptNumbers
      .map(receipt => aggregateMap.get(receipt))
      .filter(Boolean)
      .map(aggregate => ({
        ...aggregate,
        totalQuantity: aggregate.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        itemsCount: aggregate.items.length
      }));

    res.json({
      success: true,
      data: {
        sales: aggregatedSales,
        pagination: {
          page: pageNumber,
          limit: pageSize,
          total,
          totalPages: Math.ceil(total / pageSize)
        }
      }
    });
  })
);

// @route   GET /api/v1/warehouse/sales/receipt/:receiptNumber
// @desc    Get all sale items grouped by receipt number
// @access  Private (Warehouse module access)
router.get('/sales/receipt/:receiptNumber',
  authorizeModule('warehouse'),
  param('receiptNumber').isString().trim().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { receiptNumber } = req.params;
    const where = { receiptNumber };

    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.salesOfficer = req.user.id;
    }

    // ✅ UPDATED: Include debtor information
    const sales = await prisma.warehouseSale.findMany({
      where,
      include: {
        product: { select: { name: true, productNo: true } },
        warehouseCustomer: { select: { id: true, name: true, phone: true, email: true, address: true } },
        salesOfficerUser: { select: { id: true, username: true, role: true } },
        debtor: {
          select: {
            id: true,
            amountPaid: true,
            amountDue: true,
            status: true,
            dueDate: true
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    if (sales.length === 0) {
      throw new NotFoundError(`No sales found with receipt number: ${receiptNumber}`);
    }

    // ✅ UPDATED: Add payment status and debtor fields
    const aggregatedSale = {
      receiptNumber,
      saleIds: [],
      warehouseCustomerId: sales[0].warehouseCustomerId,
      customerName: sales[0].customerName || sales[0].warehouseCustomer?.name || null,
      customerPhone: sales[0].customerPhone || sales[0].warehouseCustomer?.phone || null,
      paymentMethod: sales[0].paymentMethod,
      paymentStatus: sales[0].paymentStatus,           // ✅ NEW
      creditDueDate: sales[0].creditDueDate,           // ✅ NEW
      creditNotes: sales[0].creditNotes,               // ✅ NEW
      salesOfficer: sales[0].salesOfficer,
      salesOfficerUser: sales[0].salesOfficerUser,
      warehouseCustomer: sales[0].warehouseCustomer,
      discountApplied: false,
      discountPercentage: 0,
      discountReason: null,
      totalAmount: 0,
      totalDiscountAmount: 0,
      totalCost: 0,
      grossProfit: 0,
      createdAt: sales[sales.length - 1].createdAt,
      items: [],
      debtor: null                                     // ✅ NEW
    };

    for (const sale of sales) {
      aggregatedSale.saleIds.push(sale.id);
      aggregatedSale.totalAmount += Number(sale.totalAmount);
      aggregatedSale.totalDiscountAmount += Number(sale.totalDiscountAmount || 0);
      aggregatedSale.totalCost += Number(sale.totalCost || 0);
      aggregatedSale.grossProfit += Number(sale.grossProfit || 0);
      aggregatedSale.discountApplied = aggregatedSale.discountApplied || sale.discountApplied;

      if (sale.discountPercentage && sale.discountPercentage > (aggregatedSale.discountPercentage || 0)) {
        aggregatedSale.discountPercentage = Number(sale.discountPercentage);
      }

      if (sale.discountReason && !aggregatedSale.discountReason) {
        aggregatedSale.discountReason = sale.discountReason;
      }

      if (!aggregatedSale.customerName) {
        aggregatedSale.customerName = sale.customerName || sale.warehouseCustomer?.name || null;
      }

      if (!aggregatedSale.customerPhone) {
        aggregatedSale.customerPhone = sale.customerPhone || sale.warehouseCustomer?.phone || null;
      }

      if (!aggregatedSale.warehouseCustomer && sale.warehouseCustomer) {
        aggregatedSale.warehouseCustomer = sale.warehouseCustomer;
      }

      // ✅ NEW: Capture debtor info from first sale that has it
      if (sale.debtor && !aggregatedSale.debtor) {
        aggregatedSale.debtor = {
          id: sale.debtor.id,
          amountPaid: Number(sale.debtor.amountPaid),
          amountDue: Number(sale.debtor.amountDue),
          status: sale.debtor.status,
          dueDate: sale.debtor.dueDate
        };
      }

      aggregatedSale.items.push({
        id: sale.id,
        productId: sale.productId,
        product: sale.product,
        quantity: sale.quantity,
        unitType: sale.unitType,
        unitPrice: Number(sale.unitPrice),
        totalAmount: Number(sale.totalAmount),
        totalDiscountAmount: sale.totalDiscountAmount ? Number(sale.totalDiscountAmount) : 0,
        discountApplied: sale.discountApplied,
        discountPercentage: sale.discountPercentage ? Number(sale.discountPercentage) : null,
        originalUnitPrice: sale.originalUnitPrice ? Number(sale.originalUnitPrice) : null,
        costPerUnit: Number(sale.costPerUnit || 0),
        totalCost: Number(sale.totalCost || 0),
        grossProfit: Number(sale.grossProfit || 0)
      });
    }

    aggregatedSale.totalQuantity = aggregatedSale.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    aggregatedSale.itemsCount = aggregatedSale.items.length;

    res.json({
      success: true,
      data: aggregatedSale
    });
  })
);

// @route   GET /api/v1/warehouse/sales/:id
// @desc    Get single warehouse sale
// @access  Private (Warehouse module access)
router.get('/sales/:id',
  param('id').custom(validateCuid('sale ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const where = { id };

    // Role-based access
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.salesOfficer = req.user.id;
    }

    const sale = await prisma.warehouseSale.findFirst({
      where,
      include: {
        product: true,
        salesOfficerUser: {
          select: { username: true, role: true }
        }
      }
    });

    if (!sale) {
      throw new NotFoundError('Sale not found');
    }

    res.json({
      success: true,
      data: { sale }
    });
  })
);

// ================================
// CASH FLOW ROUTES
// ================================

// @route   POST /api/v1/warehouse/cash-flow
// @desc    Create cash flow entry
// @access  Private (Cashier, Warehouse Admin)
router.post('/cash-flow',
  createCashFlowValidation,
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    // Only cashiers and warehouse admins
    if (!['CASHIER', 'WAREHOUSE_ADMIN', 'SUPER_ADMIN'].includes(req.user.role)) {
      throw new BusinessError('Access denied', 'INSUFFICIENT_PERMISSIONS');
    }

    const {
      transactionType,
      amount,
      paymentMethod,
      description,
      referenceNumber
    } = req.body;

    const cashFlow = await prisma.cashFlow.create({
      data: {
        transactionType,
        amount: parseFloat(amount),
        paymentMethod,
        description,
        referenceNumber,
        cashier: req.user.id
      },
      include: {
        cashierUser: {
          select: { username: true }
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Cash flow entry created successfully',
      data: { cashFlow }
    });
  })
);

// @route   GET /api/v1/warehouse/cash-flow
// @desc    Get cash flow entries with filtering
// @access  Private (Cashier, Warehouse Admin)
router.get('/cash-flow', asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    transactionType,
    paymentMethod,
    startDate,
    endDate,
    isReconciled
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const take = parseInt(limit);

  const where = {
    module: 'WAREHOUSE'
  };

  if (transactionType) where.transactionType = transactionType;
  if (paymentMethod) where.paymentMethod = paymentMethod;
  
  if (isReconciled !== undefined) {
    where.isReconciled = isReconciled === 'true';
  }

  if (startDate || endDate) {
    where.createdAt = {};
    if (startDate) where.createdAt.gte = new Date(startDate);
    if (endDate) where.createdAt.lte = new Date(endDate);
  }

  const [entries, total] = await Promise.all([
    prisma.cashFlow.findMany({
      where,
      include: {
        cashierUser: {
          select: { username: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take
    }),
    prisma.cashFlow.count({ where })
  ]);

  res.json({
    success: true,
    data: {
      cashFlowEntries: entries,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        totalPages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

router.use('/', warehouseExpensesRouter);


// ================================
// ANALYTICS & REPORTS
// ================================

// @route   GET /api/v1/warehouse/analytics/summary
// @desc    Get warehouse analytics summary
// @access  Private (Warehouse module access)
router.get('/analytics/summary',
  authorizeModule('warehouse'),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate) dateFilter.gte = new Date(startDate);
    if (endDate) dateFilter.lte = new Date(endDate);

    const sales = await prisma.warehouseSale.findMany({
      where: {
        createdAt: Object.keys(dateFilter).length > 0 ? dateFilter : undefined
      },
      include: { product: true }
    });

    // Calculate metrics
    let totalRevenue = 0;
    let totalCOGS = 0;
    let totalQuantitySold = 0;

    sales.forEach(sale => {
      totalRevenue += parseFloat(sale.totalAmount);
      totalCOGS += parseFloat(sale.totalCost);
      totalQuantitySold += sale.quantity;
    });

    const grossProfit = totalRevenue - totalCOGS;
    const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalCOGS: parseFloat(totalCOGS.toFixed(2)),
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          profitMargin: parseFloat(profitMargin.toFixed(2)),
          totalSales: sales.length,
          totalQuantitySold
        },
        period: { startDate, endDate }
      }
    });
  })
);

// @route   GET /api/v1/warehouse/analytics/profit-summary
// @desc    Get detailed profit summary
// @access  Private (Warehouse Admin)
router.get('/analytics/profit-summary',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    
    const where = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }

    const profitByProduct = await prisma.warehouseSale.groupBy({
      by: ['productId'],
      where,
      _sum: {
        totalAmount: true,
        totalCost: true,
        grossProfit: true,
        quantity: true
      },
      _avg: {
        profitMargin: true
      },
      _count: true,
      orderBy: {
        _sum: {
          grossProfit: 'desc'
        }
      }
    });

    // Get product details
    const productIds = profitByProduct.map(p => p.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, productNo: true }
    });

    const profitAnalysis = profitByProduct.map(item => ({
      product: products.find(p => p.id === item.productId),
      salesCount: item._count,
      totalQuantity: item._sum.quantity,
      revenue: parseFloat((item._sum.totalAmount || 0).toFixed(2)),
      cost: parseFloat((item._sum.totalCost || 0).toFixed(2)),
      profit: parseFloat((item._sum.grossProfit || 0).toFixed(2)),
      avgMargin: parseFloat((item._avg.profitMargin || 0).toFixed(2))
    }));

    const totals = profitAnalysis.reduce((acc, item) => ({
      revenue: acc.revenue + item.revenue,
      cost: acc.cost + item.cost,
      profit: acc.profit + item.profit
    }), { revenue: 0, cost: 0, profit: 0 });

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totals.revenue.toFixed(2)),
          totalCost: parseFloat(totals.cost.toFixed(2)),
          totalProfit: parseFloat(totals.profit.toFixed(2)),
          overallMargin: totals.revenue > 0 ? 
            parseFloat(((totals.profit / totals.revenue) * 100).toFixed(2)) : 0
        },
        profitByProduct: profitAnalysis
      }
    });
  })
);

// ================================
// SALES EXPORT ROUTES
// ================================

// @route   GET /api/v1/warehouse/sales/export/csv
// @desc    Export warehouse sales to CSV with filters
// @access  Private (Warehouse module access)
router.get('/sales/export/csv',
  [
    query('period').optional().isIn(['day', 'week', 'month', 'year', 'custom']),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('customerId').optional(),
    query('productId').optional()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { period, startDate, endDate, customerId, productId } = req.query;
    
    const where = {};
    
    // Date filtering based on period
    if (period && period !== 'custom') {
      const now = new Date();
      where.createdAt = {};
      
      switch(period) {
        case 'day':
          where.createdAt.gte = new Date(now.setHours(0,0,0,0));
          break;
        case 'week':
          const weekStart = new Date(now);
          weekStart.setDate(now.getDate() - now.getDay());
          weekStart.setHours(0,0,0,0);
          where.createdAt.gte = weekStart;
          break;
        case 'month':
          where.createdAt.gte = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'year':
          where.createdAt.gte = new Date(now.getFullYear(), 0, 1);
          break;
      }
    } else if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    
    if (customerId) where.customerId = customerId;
    if (productId) where.productId = productId;

    // Role-based access
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.salesOfficer = req.user.id;
    }

    const sales = await prisma.warehouseSale.findMany({
      where,
      include: {
        product: { select: { name: true, productNo: true } },
        customer: { select: { name: true, phone: true } },
        salesOfficerUser: { select: { username: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const fields = [
      { label: 'Sale ID', value: 'saleId' },
      { label: 'Product Name', value: 'productName' },
      { label: 'Product No', value: 'productNo' },
      { label: 'Customer Name', value: 'customerName' },
      { label: 'Customer Phone', value: 'customerPhone' },
      { label: 'Quantity', value: 'quantity' },
      { label: 'Unit Price (NGN)', value: 'unitPrice' },
      { label: 'Total Amount (NGN)', value: 'totalAmount' },
      { label: 'Discount Applied', value: 'discountApplied' },
      { label: 'Discount Amount (NGN)', value: 'discountAmount' },
      { label: 'Discount %', value: 'discountPercentage' },
      { label: 'Cost Per Unit (NGN)', value: 'costPerUnit' },
      { label: 'Total Cost (NGN)', value: 'totalCost' },
      { label: 'Gross Profit (NGN)', value: 'grossProfit' },
      { label: 'Sales Officer', value: 'salesOfficer' },
      { label: 'Created At', value: 'createdAt' }
    ];

    const csvData = sales.map(sale => ({
      saleId: `WS-${sale.id.slice(-8)}`,
      productName: sale.product?.name || 'N/A',
      productNo: sale.product?.productNo || 'N/A',
      customerName: sale.customer?.name || 'Walk-in Customer',
      customerPhone: sale.customer?.phone || 'N/A',
      quantity: sale.quantity,
      unitPrice: parseFloat(sale.unitPrice).toFixed(2),
      totalAmount: parseFloat(sale.totalAmount).toFixed(2),
      discountApplied: sale.discountApplied ? 'Yes' : 'No',
      discountAmount: parseFloat(sale.totalDiscountAmount || 0).toFixed(2),
      discountPercentage: sale.discountPercentage ? parseFloat(sale.discountPercentage).toFixed(2) : '0.00',
      costPerUnit: parseFloat(sale.costPerUnit || 0).toFixed(2),
      totalCost: parseFloat(sale.totalCost || 0).toFixed(2),
      grossProfit: parseFloat(sale.grossProfit || 0).toFixed(2),
      salesOfficer: sale.salesOfficerUser?.username || 'N/A',
      createdAt: new Date(sale.createdAt).toLocaleString('en-NG')
    }));

    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=warehouse-sales-${new Date().toISOString().split('T')[0]}.csv`);
    res.send('\uFEFF' + csv);
  })
);

// @route   GET /api/v1/warehouse/sales/export/pdf
// @desc    Export warehouse sales list to PDF
// @access  Private (Warehouse module access)
router.get('/sales/export/pdf',
  [
    query('period').optional().isIn(['day', 'week', 'month', 'year', 'custom']),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('customerId').optional(),
    query('productId').optional(),
    query('limit').optional().isInt({ min: 1, max: 1000 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const { period, startDate, endDate, customerId, productId, limit = 100 } = req.query;
    
    const where = {};
    
    // Date filtering based on period
    if (period && period !== 'custom') {
      const now = new Date();
      where.createdAt = {};
      
      switch(period) {
        case 'day':
          where.createdAt.gte = new Date(now.setHours(0,0,0,0));
          break;
        case 'week':
          const weekStart = new Date(now);
          weekStart.setDate(now.getDate() - now.getDay());
          weekStart.setHours(0,0,0,0);
          where.createdAt.gte = weekStart;
          break;
        case 'month':
          where.createdAt.gte = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'year':
          where.createdAt.gte = new Date(now.getFullYear(), 0, 1);
          break;
      }
    } else if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    
    if (customerId) where.customerId = customerId;
    if (productId) where.productId = productId;

    // Role-based access
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.salesOfficer = req.user.id;
    }

    const sales = await prisma.warehouseSale.findMany({
      where,
      take: parseInt(limit),
      include: {
        product: { select: { name: true, productNo: true } },
        customer: { select: { name: true } },
        salesOfficerUser: { select: { username: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const doc = new PDFDocument({ 
      margin: 30, 
      size: 'A4', 
      layout: 'landscape'
    });
    
    const filename = `warehouse-sales-${new Date().toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    doc.pipe(res);

    // Header
    doc.fontSize(20)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('WAREHOUSE SALES REPORT', { align: 'center' });
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#666')
       .text(`Generated on ${new Date().toLocaleString('en-NG')}`, { align: 'center' });

    if (period || startDate || endDate) {
      let periodText = '';
      if (period && period !== 'custom') {
        periodText = `Period: ${period.charAt(0).toUpperCase() + period.slice(1)}`;
      } else if (startDate || endDate) {
        periodText = `Period: ${startDate ? new Date(startDate).toLocaleDateString() : 'Start'} - ${endDate ? new Date(endDate).toLocaleDateString() : 'End'}`;
      }
      doc.text(periodText, { align: 'center' });
    }

    doc.moveDown(1.5);

    // Calculate totals
    let totalRevenue = 0;
    let totalCost = 0;
    let totalProfit = 0;
    let totalDiscounts = 0;
    
    sales.forEach(sale => {
      totalRevenue += parseFloat(sale.totalAmount || 0);
      totalCost += parseFloat(sale.totalCost || 0);
      totalProfit += parseFloat(sale.grossProfit || 0);
      totalDiscounts += parseFloat(sale.totalDiscountAmount || 0);
    });

    // Summary Box
    const summaryY = doc.y;
    doc.fontSize(12)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('SUMMARY', 50, summaryY);
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');
    
    const summaryData = [
      ['Total Sales:', sales.length],
      ['Total Revenue:', `NGN ${totalRevenue.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Total Cost:', `NGN ${totalCost.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Gross Profit:', `NGN ${totalProfit.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Total Discounts:', `NGN ${totalDiscounts.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Profit Margin:', `${totalRevenue > 0 ? ((totalProfit / totalRevenue) * 100).toFixed(2) : 0}%`]
    ];

    let yPos = summaryY + 20;
    summaryData.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
      doc.font('Helvetica').text(String(value), { width: 200 });
      yPos += 15;
    });

    doc.moveDown(2);

    // Table
    const tableData = {
      headers: [
        'Sale ID',
        'Product',
        'Customer',
        'Qty',
        'Amount (NGN)',
        'Discount (NGN)',
        'Profit (NGN)',
        'Date'
      ],
      rows: sales.map(sale => [
        `WS-${sale.id.slice(-8)}`,
        (sale.product?.name || 'N/A').substring(0, 20),
        (sale.customer?.name || 'Walk-in').substring(0, 15),
        sale.quantity,
        parseFloat(sale.totalAmount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        parseFloat(sale.totalDiscountAmount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        parseFloat(sale.grossProfit || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        new Date(sale.createdAt).toLocaleDateString('en-NG')
      ])
    };

    const tableTop = doc.y;
    const colWidths = [70, 100, 90, 40, 85, 85, 85, 75];
    const rowHeight = 25;
    let currentY = tableTop;

    // Table Header
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .fillColor('#fff');
    
    doc.rect(30, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
       .fill('#1e40af');

    let xPos = 35;
    tableData.headers.forEach((header, i) => {
      doc.text(header, xPos, currentY + 8, { 
        width: colWidths[i] - 10, 
        align: 'left' 
      });
      xPos += colWidths[i];
    });

    currentY += rowHeight;

    // Table Rows
    doc.font('Helvetica')
       .fontSize(8)
       .fillColor('#000');

    tableData.rows.forEach((row, rowIndex) => {
      if (currentY > 500) {
        doc.addPage({ layout: 'landscape' });
        currentY = 50;
      }

      // Alternating row colors
      if (rowIndex % 2 === 0) {
        doc.rect(30, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
           .fill('#f3f4f6');
      }

      xPos = 35;
      row.forEach((cell, i) => {
        doc.fillColor('#000')
           .text(String(cell), xPos, currentY + 8, { 
             width: colWidths[i] - 10, 
             align: i >= 3 && i <= 6 ? 'right' : 'left' 
           });
        xPos += colWidths[i];
      });

      currentY += rowHeight;
    });

    // Footer
    const footerY = doc.page.height - 80;
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#666')
       .text('Premium G Enterprise - Warehouse Division', 50, footerY, { 
         align: 'center', 
         width: doc.page.width - 100 
       });
    
    doc.text('This is a computer-generated document', 50, footerY + 15, { 
      align: 'center', 
      width: doc.page.width - 100 
    });

    doc.end();
  })
);

// @route   GET /api/v1/warehouse/sales/:id/export/pdf
// @desc    Export individual sale detail to PDF
// @access  Private (Warehouse module access)
router.get('/sales/:id/export/pdf',
  param('id').custom(validateCuid('sale ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const where = { id };

    // Role-based access
    if (!req.user.role.includes('ADMIN') && req.user.role !== 'SUPER_ADMIN') {
      where.salesOfficer = req.user.id;
    }

    const sale = await prisma.warehouseSale.findFirst({
      where,
      include: {
        product: true,
        customer: true,
        salesOfficerUser: {
          select: { username: true, role: true }
        }
      }
    });

    if (!sale) {
      throw new NotFoundError('Sale not found');
    }

    const doc = new PDFDocument({ 
      margin: 50, 
      size: 'A4'
    });
    
    const filename = `warehouse-sale-${sale.id.slice(-8)}-${new Date().toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    doc.pipe(res);

    // ===== HEADER SECTION =====
    doc.rect(0, 0, doc.page.width, 120)
       .fill('#1e40af');

    doc.fontSize(28)
       .font('Helvetica-Bold')
       .fillColor('#ffffff')
       .text('PREMIUM G ENTERPRISE', 50, 30);
    
    doc.fontSize(11)
       .font('Helvetica')
       .fillColor('#e0e7ff')
       .text('Warehouse Sale Receipt', 50, 65);
    
    // Sale ID and date on right
    doc.fontSize(10)
       .fillColor('#ffffff')
       .text(`Sale ID: WS-${sale.id.slice(-8)}`, 400, 40, { align: 'right' });
    
    doc.fontSize(9)
       .fillColor('#e0e7ff')
       .text(`Date: ${new Date(sale.createdAt).toLocaleDateString('en-NG', { 
         year: 'numeric', 
         month: 'long', 
         day: 'numeric' 
       })}`, 400, 60, { align: 'right' });

    let yPos = 150;

    // ===== CUSTOMER INFORMATION =====
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('CUSTOMER INFORMATION', 50, yPos);
    
    yPos += 25;

    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');

    const customerInfo = [
      ['Customer Name:', sale.customer?.name || 'Walk-in Customer'],
      ['Phone:', sale.customer?.phone || 'N/A'],
      ['Email:', sale.customer?.email || 'N/A']
    ];

    customerInfo.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
      doc.font('Helvetica').text(value, { width: 350 });
      yPos += 20;
    });

    yPos += 20;

    // ===== PRODUCT INFORMATION =====
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('PRODUCT DETAILS', 50, yPos);
    
    yPos += 25;

    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');

    const productInfo = [
      ['Product Name:', sale.product?.name || 'N/A'],
      ['Product Number:', sale.product?.productNo || 'N/A'],
      ['Quantity:', `${sale.quantity} packs`],
      ['Unit Price:', `NGN ${parseFloat(sale.unitPrice).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`]
    ];

    productInfo.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
      doc.font('Helvetica').text(String(value), { width: 350 });
      yPos += 20;
    });

    yPos += 20;

    // ===== PRICING BREAKDOWN =====
    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('PRICING BREAKDOWN', 50, yPos);
    
    yPos += 25;

    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');

    const subtotal = sale.originalUnitPrice 
      ? parseFloat(sale.originalUnitPrice) * sale.quantity 
      : parseFloat(sale.unitPrice) * sale.quantity;

    const pricingInfo = [];
    
    if (sale.discountApplied) {
      pricingInfo.push(['Subtotal (Before Discount):', `NGN ${subtotal.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`]);
      pricingInfo.push(['Discount Applied:', `${parseFloat(sale.discountPercentage || 0).toFixed(2)}%`]);
      pricingInfo.push(['Discount Amount:', `NGN ${parseFloat(sale.totalDiscountAmount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`]);
    }
    
    pricingInfo.push(['Total Amount:', `NGN ${parseFloat(sale.totalAmount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`]);

    pricingInfo.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 200, continued: true });
      doc.font('Helvetica').text(value, { width: 300 });
      yPos += 20;
    });

    yPos += 20;

    // ===== COST & PROFIT ANALYSIS =====
    if (req.user.role.includes('ADMIN') || req.user.role === 'SUPER_ADMIN') {
      doc.fontSize(14)
         .font('Helvetica-Bold')
         .fillColor('#1e40af')
         .text('COST & PROFIT ANALYSIS', 50, yPos);
      
      yPos += 25;

      doc.fontSize(10)
         .font('Helvetica')
         .fillColor('#000');

      const profitInfo = [
        ['Cost Per Unit:', `NGN ${parseFloat(sale.costPerUnit || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
        ['Total Cost:', `NGN ${parseFloat(sale.totalCost || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
        ['Gross Profit:', `NGN ${parseFloat(sale.grossProfit || 0).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
        ['Profit Margin:', `${parseFloat(sale.totalAmount) > 0 ? ((parseFloat(sale.grossProfit || 0) / parseFloat(sale.totalAmount)) * 100).toFixed(2) : 0}%`]
      ];

      profitInfo.forEach(([label, value]) => {
        doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
        doc.font('Helvetica').text(value, { width: 350 });
        yPos += 20;
      });

      yPos += 20;
    }

    // ===== ADDITIONAL INFORMATION =====
    if (yPos > 650) {
      doc.addPage();
      yPos = 50;
    }

    doc.fontSize(14)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('ADDITIONAL INFORMATION', 50, yPos);
    
    yPos += 25;

    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');

    const additionalInfo = [
      ['Sales Officer:', sale.salesOfficerUser?.username || 'N/A'],
      ['Created At:', new Date(sale.createdAt).toLocaleString('en-NG')],
      ['Last Updated:', new Date(sale.updatedAt).toLocaleString('en-NG')]
    ];

    additionalInfo.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
      doc.font('Helvetica').text(value, { width: 350 });
      yPos += 20;
    });

    // ===== FOOTER =====
    const footerY = doc.page.height - 80;
    
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#666')
       .text('Premium G Enterprise - Warehouse Division', 50, footerY, { align: 'center', width: doc.page.width - 100 });
    
    doc.text('This is a computer-generated document', 50, footerY + 15, { align: 'center', width: doc.page.width - 100 });
    
    doc.text('Thank you for your business!', 50, footerY + 30, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  })
);

// ================================
// CASH FLOW EXPORT ROUTES (WAREHOUSE)
// ================================

// @route   GET /api/v1/warehouse/cash-flow/export/csv
// @desc    Export warehouse cash flow to CSV
// @access  Private (Warehouse module access)
router.get('/cash-flow/export/csv',
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('transactionType').optional().isIn(['CASH_IN', 'CASH_OUT', 'SALE']),
    query('paymentMethod').optional()
  ],
  asyncHandler(async (req, res) => {
    const { startDate, endDate, transactionType, paymentMethod } = req.query;
    
    const where = { module: 'WAREHOUSE' };
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    
    if (transactionType) where.transactionType = transactionType;
    if (paymentMethod) where.paymentMethod = paymentMethod;

    const cashFlows = await prisma.cashFlow.findMany({
      where,
      include: {
        cashierUser: { select: { username: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const fields = [
      { label: 'Transaction Type', value: 'transactionType' },
      { label: 'Amount (NGN)', value: 'amount' },
      { label: 'Payment Method', value: 'paymentMethod' },
      { label: 'Description', value: 'description' },
      { label: 'Reference Number', value: 'referenceNumber' },
      { label: 'Cashier', value: 'cashier' },
      { label: 'Reconciled', value: 'isReconciled' },
      { label: 'Created At', value: 'createdAt' }
    ];

    const csvData = cashFlows.map(cf => ({
      transactionType: cf.transactionType,
      amount: parseFloat(cf.amount).toFixed(2),
      paymentMethod: cf.paymentMethod,
      description: cf.description || 'N/A',
      referenceNumber: cf.referenceNumber || 'N/A',
      cashier: cf.cashierUser?.username || 'N/A',
      isReconciled: cf.isReconciled ? 'Yes' : 'No',
      createdAt: new Date(cf.createdAt).toLocaleString('en-NG')
    }));

    const parser = new Parser({ fields });
    const csv = parser.parse(csvData);

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=warehouse-cashflow-${new Date().toISOString().split('T')[0]}.csv`);
    res.send('\uFEFF' + csv);
  })
);

// @route   GET /api/v1/warehouse/cash-flow/export/pdf
// @desc    Export warehouse cash flow to PDF
// @access  Private (Warehouse module access)
router.get('/cash-flow/export/pdf',
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('transactionType').optional(),
    query('paymentMethod').optional()
  ],
  asyncHandler(async (req, res) => {
    const { startDate, endDate, transactionType, paymentMethod } = req.query;
    
    const where = { module: 'WAREHOUSE' };
    
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate) where.createdAt.lte = new Date(endDate);
    }
    
    if (transactionType) where.transactionType = transactionType;
    if (paymentMethod) where.paymentMethod = paymentMethod;

    const cashFlows = await prisma.cashFlow.findMany({
      where,
      include: {
        cashierUser: { select: { username: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const doc = new PDFDocument({ 
      margin: 30, 
      size: 'A4', 
      layout: 'portrait'
    });
    
    const filename = `warehouse-cashflow-${new Date().toISOString().split('T')[0]}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    doc.pipe(res);

    // Header
    doc.fontSize(20)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('WAREHOUSE CASH FLOW REPORT', { align: 'center' });
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#666')
       .text(`Generated on ${new Date().toLocaleString('en-NG')}`, { align: 'center' });

    doc.moveDown(1.5);

    // Calculate totals
    let totalCashIn = 0;
    let totalCashOut = 0;
    
    cashFlows.forEach(cf => {
      if (cf.transactionType === 'CASH_IN' || cf.transactionType === 'SALE') {
        totalCashIn += parseFloat(cf.amount);
      } else {
        totalCashOut += parseFloat(cf.amount);
      }
    });

    const netCashFlow = totalCashIn - totalCashOut;

    // Summary
    doc.fontSize(12)
       .font('Helvetica-Bold')
       .fillColor('#1e40af')
       .text('SUMMARY', 50);
    
    doc.fontSize(10)
       .font('Helvetica')
       .fillColor('#000');
    
    let yPos = doc.y + 10;
    const summaryData = [
      ['Total Cash In:', `NGN ${totalCashIn.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Total Cash Out:', `NGN ${totalCashOut.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Net Cash Flow:', `NGN ${netCashFlow.toLocaleString('en-NG', { minimumFractionDigits: 2 })}`],
      ['Total Transactions:', cashFlows.length]
    ];

    summaryData.forEach(([label, value]) => {
      doc.font('Helvetica-Bold').text(label, 50, yPos, { width: 150, continued: true });
      doc.font('Helvetica').text(value, { width: 350 });
      yPos += 20;
    });

    doc.moveDown(2);

    // Table
    const tableData = {
      headers: ['Date', 'Type', 'Amount (NGN)', 'Method', 'Description', 'Cashier'],
      rows: cashFlows.map(cf => [
        new Date(cf.createdAt).toLocaleDateString('en-NG'),
        cf.transactionType,
        parseFloat(cf.amount).toLocaleString('en-NG', { minimumFractionDigits: 2 }),
        cf.paymentMethod,
        (cf.description || 'N/A').substring(0, 30),
        cf.cashierUser?.username || 'N/A'
      ])
    };

    const tableTop = doc.y;
    const colWidths = [70, 70, 90, 70, 120, 80];
    const rowHeight = 30;
    let currentY = tableTop;

    // Table Header
    doc.fontSize(9)
       .font('Helvetica-Bold')
       .fillColor('#fff');
    
    doc.rect(30, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
       .fill('#1e40af');

    let xPos = 35;
    tableData.headers.forEach((header, i) => {
      doc.text(header, xPos, currentY + 10, { 
        width: colWidths[i] - 10, 
        align: 'left' 
      });
      xPos += colWidths[i];
    });

    currentY += rowHeight;

    // Table Rows
    doc.font('Helvetica')
       .fontSize(8)
       .fillColor('#000');

    tableData.rows.forEach((row, rowIndex) => {
      if (currentY > 700) {
        doc.addPage();
        currentY = 50;
      }

      if (rowIndex % 2 === 0) {
        doc.rect(30, currentY, colWidths.reduce((a, b) => a + b, 0), rowHeight)
           .fill('#f3f4f6');
      }

      xPos = 35;
      row.forEach((cell, i) => {
        doc.fillColor('#000')
           .text(String(cell), xPos, currentY + 10, { 
             width: colWidths[i] - 10, 
             align: i === 2 ? 'right' : 'left' 
           });
        xPos += colWidths[i];
      });

      currentY += rowHeight;
    });

    // Footer
    const footerY = doc.page.height - 80;
    doc.fontSize(8)
       .font('Helvetica')
       .fillColor('#666')
       .text('Premium G Enterprise - Warehouse Division', 50, footerY, { 
         align: 'center', 
         width: doc.page.width - 100 
       });

    doc.end();
  })
);

module.exports = router;
