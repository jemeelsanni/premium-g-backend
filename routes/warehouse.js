const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const PDFDocument = require('pdfkit');
const { Parser } = require('json2csv');

const { asyncHandler, ValidationError, NotFoundError, BusinessError } = require('../middleware/errorHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { validateCuid } = require('../utils/validators');
const { syncProductInventory } = require('../services/inventorySyncService');

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
router.use('/debtors', warehouseDebtorsRouter);

const warehouseOpeningStockRouter = require('./warehouse-opening-stock');
router.use('/opening-stock', warehouseOpeningStockRouter);

const warehouseStockCountRouter = require('./warehouse-stock-count');
router.use('/', warehouseStockCountRouter);


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

  const inventory = await prisma.warehouseInventory.findMany({
    where,
    include: { product: true },
    orderBy: { lastUpdated: 'desc' }
  });

  // ✅ FIXED: Calculate stock value using purchase cost from batches
  const formattedInventory = [];
  
  for (const inv of inventory) {
    const product = inv.product;
    const packsPerPallet = product?.packsPerPallet || 1;
    
    // Convert to packs
    const palletsToPacks = (inv.pallets ?? 0) * packsPerPallet;
    const totalPacks = palletsToPacks + (inv.packs ?? 0);

    // Get configured reorder levels
    let minimumStock = inv.reorderLevel ?? 0;
    const maximumStock = inv.maxStockLevel ?? 0;

    // ✅ FIX: If reorderLevel is not set (0), use intelligent default of 10% of current stock
    // This ensures products show LOW_STOCK when they're actually running low
    if (minimumStock === 0 && totalPacks > 0) {
      // Use 20 packs or 10% of total stock, whichever is smaller
      minimumStock = Math.min(20, Math.ceil(totalPacks * 0.1));
    }

    let stockStatus = 'NORMAL';
    if (totalPacks === 0) {
      stockStatus = 'OUT_OF_STOCK';
    } else if (totalPacks <= minimumStock) {
      stockStatus = 'LOW_STOCK';
    } else if (maximumStock > 0 && totalPacks >= maximumStock) {
      stockStatus = 'OVERSTOCK';
    }

    // ✅ NEW: Get weighted average cost from active batches
    const activeBatches = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: inv.productId,
        batchStatus: 'ACTIVE',
        quantityRemaining: { gt: 0 }
      },
      select: {
        costPerUnit: true,
        quantityRemaining: true
      }
    });

    let weightedAvgCost = 0;
    if (activeBatches.length > 0) {
      const totalCost = activeBatches.reduce((sum, batch) =>
        sum + (parseFloat(batch.costPerUnit) * batch.quantityRemaining), 0
      );
      const totalQty = activeBatches.reduce((sum, batch) =>
        sum + batch.quantityRemaining, 0
      );
      weightedAvgCost = totalQty > 0 ? totalCost / totalQty : 0;
    }

    const stockValue = totalPacks * weightedAvgCost;

    // ✅ FIX: Get the actual last purchase date (most recent restock)
    const lastPurchase = await prisma.warehouseProductPurchase.findFirst({
      where: {
        productId: inv.productId
      },
      orderBy: { purchaseDate: 'desc' },
      select: { purchaseDate: true }
    });

    formattedInventory.push({
      id: inv.id,
      productId: inv.productId,
      product: inv.product,
      location: inv.location,
      pallets: inv.pallets ?? 0,
      packs: inv.packs ?? 0,
      units: inv.units ?? 0,
      currentStock: totalPacks,
      minimumStock,
      maximumStock,
      lastRestocked: lastPurchase?.purchaseDate ?? inv.createdAt,
      stockStatus,
      // ✅ NEW FIELDS: Stock valuation based on purchase cost
      costPerUnit: parseFloat(weightedAvgCost.toFixed(2)),
      stockValue: parseFloat(stockValue.toFixed(2)),
      // ✅ OPTIONAL: Also include selling price for comparison
      sellingPricePerUnit: parseFloat(product?.pricePerPack || 0),
      potentialRevenue: parseFloat((totalPacks * parseFloat(product?.pricePerPack || 0)).toFixed(2))
    });
  }

  // Apply low stock filter if requested
  let filteredInventory = formattedInventory;
  if (lowStock === 'true') {
    filteredInventory = formattedInventory.filter(
      (inv) => inv.stockStatus === 'LOW_STOCK' || inv.stockStatus === 'OUT_OF_STOCK'
    );
  }

  res.json({
    success: true,
    data: filteredInventory
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
    body('reorderLevel').optional().isInt({ min: 0 }),
    body('reason').optional().isString().notEmpty().withMessage('Reason is recommended for inventory changes')
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { reason, ...updateData } = req.body;

    // Get old inventory values before update
    const oldInventory = await prisma.warehouseInventory.findUnique({
      where: { id },
      include: { product: true }
    });

    if (!oldInventory) {
      throw new NotFoundError('Inventory not found');
    }

    // Update inventory
    const inventory = await prisma.warehouseInventory.update({
      where: { id },
      data: updateData,
      include: {
        product: true
      }
    });

    // Create audit log
    const { logInventoryChange, getRequestMetadata } = require('../utils/auditLogger');
    const { ipAddress, userAgent } = getRequestMetadata(req);

    await logInventoryChange({
      userId: req.user.id,
      action: 'UPDATE',
      inventoryId: inventory.id,
      productId: inventory.productId,
      productName: inventory.product.name,
      oldInventory: {
        pallets: oldInventory.pallets,
        packs: oldInventory.packs,
        units: oldInventory.units,
        reorderLevel: oldInventory.reorderLevel
      },
      newInventory: {
        pallets: inventory.pallets,
        packs: inventory.packs,
        units: inventory.units,
        reorderLevel: inventory.reorderLevel
      },
      reason: reason || 'No reason provided',
      triggeredBy: 'MANUAL_ADJUSTMENT',
      ipAddress,
      userAgent
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
    orderBy: { name: 'asc' },
    include: {
      warehouseInventory: {
        select: {
          pallets: true,
          packs: true,
          units: true,
          reorderLevel: true,
          maxStockLevel: true
        }
      }
    }
  });

  const formattedProducts = products.map(p => {
    // 🧠 Handle multiple inventories
    const inventories = Array.isArray(p.warehouseInventory)
      ? p.warehouseInventory
      : [p.warehouseInventory].filter(Boolean);

    const totalStock = inventories.reduce(
      (sum, inv) => sum + (inv.pallets ?? 0) + (inv.packs ?? 0) + (inv.units ?? 0),
      0
    );

    const minLevel = Math.min(...inventories.map(inv => inv.reorderLevel ?? 0), 0);
    const maxLevel = Math.max(...inventories.map(inv => inv.maxStockLevel ?? 0), 0);

    const stockStatus =
      totalStock <= minLevel
        ? 'LOW_STOCK'
        : maxLevel && totalStock >= maxLevel
        ? 'OVERSTOCK'
        : 'NORMAL';

    return {
      id: p.id,
      name: p.name,
      productNo: p.productNo,
      pricePerPack: p.pricePerPack,
      minSellingPrice: p.minSellingPrice,
      maxSellingPrice: p.maxSellingPrice,
      currentStock: totalStock,
      minimumStock: minLevel,
      maximumStock: maxLevel,
      stockStatus
    };
  });

  res.json({
    success: true,
    data: { products: formattedProducts }
  });
}));






// ================================
// WAREHOUSE SALES ROUTES
// ================================


/**
 * AUTO-FIX: Automatically fix batch integrity issues before sale
 * This ensures quantitySold matches tracked sales and quantity = sold + remaining
 */
async function autoFixBatchIntegrity(productId) {
  console.log('🔧 Running auto-fix for product batch integrity...');

  // Find batches with integrity issues for this product
  const problematicBatches = await prisma.$queryRaw`
    SELECT
      wpp.id,
      wpp.batch_number,
      wpp.quantity,
      wpp.quantity_sold,
      wpp.quantity_remaining,
      COALESCE(SUM(wbs.quantity_sold), 0) as tracked_sales
    FROM warehouse_product_purchases wpp
    LEFT JOIN warehouse_batch_sales wbs ON wbs.batch_id = wpp.id
    WHERE wpp.product_id = ${productId}
    GROUP BY wpp.id, wpp.batch_number, wpp.quantity, wpp.quantity_sold, wpp.quantity_remaining
    HAVING
      wpp.quantity_sold != COALESCE(SUM(wbs.quantity_sold), 0)
      OR wpp.quantity_remaining < 0
      OR wpp.quantity_sold < 0
      OR wpp.quantity_remaining + wpp.quantity_sold != wpp.quantity
  `;

  if (problematicBatches.length === 0) {
    console.log('✅ No batch integrity issues found for this product');
    return;
  }

  console.log(`⚠️ Found ${problematicBatches.length} batch(es) with integrity issues. Auto-fixing...`);

  for (const batch of problematicBatches) {
    const trackedSales = Number(batch.tracked_sales) || 0;

    // Calculate correct values - tracked sales is the source of truth
    let newQuantity = Math.max(Number(batch.quantity), trackedSales);
    let newRemaining = newQuantity - trackedSales;

    // Ensure no negative values
    if (newRemaining < 0) {
      newQuantity = trackedSales;
      newRemaining = 0;
    }

    await prisma.warehouseProductPurchase.update({
      where: { id: batch.id },
      data: {
        quantity: newQuantity,
        quantitySold: trackedSales,
        quantityRemaining: newRemaining,
        batchStatus: newRemaining <= 0 ? 'DEPLETED' : 'ACTIVE'
      }
    });

    console.log(`  ✅ Fixed batch ${batch.batch_number}: quantity=${newQuantity}, sold=${trackedSales}, remaining=${newRemaining}`);
  }

  console.log('✅ Batch integrity auto-fix completed');
}

/**
 * Calculate simple average purchase cost from all active batches
 * Average = (Sum of all batch prices) / (Number of batches)
 */
async function calculateSimpleAverageCost(tx, productId, unitType) {
  const allBatches = await tx.warehouseProductPurchase.findMany({
    where: {
      productId,
      unitType,
      batchStatus: 'ACTIVE',
      quantityRemaining: { gt: 0 }
    }
  });

  if (allBatches.length === 0) {
    throw new BusinessError('No active batches available for cost calculation', 'NO_BATCHES');
  }

  // Simple average: Add all batch prices and divide by number of batches
  const sumOfPrices = allBatches.reduce((sum, batch) => {
    return sum + parseFloat(batch.costPerUnit);
  }, 0);

  const averageCost = sumOfPrices / allBatches.length;

  console.log('📊 Simple Average Cost Calculation:', {
    product: productId,
    unitType,
    numberOfBatches: allBatches.length,
    batchPrices: allBatches.map(b => parseFloat(b.costPerUnit)),
    sumOfPrices,
    averageCost: averageCost.toFixed(2)
  });

  return parseFloat(averageCost.toFixed(2));
}

async function allocateSaleQuantityFEFO(tx, productId, quantityToSell, unitType) {
  // ============================================================================
  // PESSIMISTIC LOCKING: Lock batches to prevent race conditions
  // This ensures no two concurrent sales can allocate from the same batch
  // ============================================================================

  // Use raw SQL with FOR UPDATE to lock the rows during allocation
  // This prevents race conditions where two sales read the same stock level
  const availableBatches = await tx.$queryRaw`
    SELECT
      id,
      batch_number as "batchNumber",
      expiry_date as "expiryDate",
      cost_per_unit as "costPerUnit",
      quantity_remaining as "quantityRemaining",
      quantity_sold as "quantitySold",
      batch_status as "batchStatus"
    FROM warehouse_product_purchases
    WHERE product_id = ${productId}
      AND unit_type = ${unitType}::"UnitType"
      AND batch_status = 'ACTIVE'::"BatchStatus"
      AND quantity_remaining > 0
    ORDER BY expiry_date ASC NULLS LAST, purchase_date ASC
    FOR UPDATE
  `;

  if (!availableBatches || availableBatches.length === 0) {
    throw new BusinessError('No active batches available for this product', 'NO_BATCHES');
  }

  // Calculate total available quantity
  const totalAvailable = availableBatches.reduce(
    (sum, batch) => sum + batch.quantityRemaining,
    0
  );

  if (totalAvailable < quantityToSell) {
    throw new BusinessError(
      `Insufficient stock. Available: ${totalAvailable}, Requested: ${quantityToSell}`,
      'INSUFFICIENT_STOCK'
    );
  }

  // Allocate quantity across batches
  const allocations = [];
  let remainingToSell = quantityToSell;

  for (const batch of availableBatches) {
    if (remainingToSell === 0) break;

    const quantityFromThisBatch = Math.min(remainingToSell, batch.quantityRemaining);

    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      costPerUnit: batch.costPerUnit,
      quantityAllocated: quantityFromThisBatch
      // Note: newRemainingQty and newSoldQty removed - using atomic increment/decrement instead
    });

    remainingToSell -= quantityFromThisBatch;
  }

  return allocations;
}

/**
 * Update batches and create batch-sale records
 * Now includes audit logging for inventory changes
 */
async function updateBatchesAfterSale(tx, saleId, allocations, userId, ipAddress, userAgent) {
  const batchSaleRecords = [];
  const { logInventoryChange } = require('../utils/auditLogger');

  for (const allocation of allocations) {
    // Get the batch before update (for audit logging)
    const batchBefore = await tx.warehouseProductPurchase.findUnique({
      where: { id: allocation.batchId }
    });

    // ========================================================================
    // ATOMIC UPDATE: Use increment/decrement to prevent race conditions
    // This ensures concurrent transactions don't overwrite each other's updates
    // ========================================================================
    const updatedBatch = await tx.warehouseProductPurchase.update({
      where: { id: allocation.batchId },
      data: {
        quantityRemaining: { decrement: allocation.quantityAllocated },
        quantitySold: { increment: allocation.quantityAllocated }
      }
    });

    // Update status based on actual remaining quantity (after atomic update)
    let newStatus = updatedBatch.batchStatus;
    if (updatedBatch.quantityRemaining <= 0) {
      newStatus = 'DEPLETED';
      await tx.warehouseProductPurchase.update({
        where: { id: allocation.batchId },
        data: { batchStatus: 'DEPLETED' }
      });
      updatedBatch.batchStatus = 'DEPLETED';
    }

    // Log the inventory change to audit log
    await logInventoryChange({
      userId,
      action: 'UPDATE',
      entity: 'WarehouseBatch',
      entityId: allocation.batchId,
      oldValues: {
        batchNumber: batchBefore.batchNumber,
        quantityRemaining: batchBefore.quantityRemaining,
        quantitySold: batchBefore.quantitySold,
        batchStatus: batchBefore.batchStatus
      },
      newValues: {
        batchNumber: updatedBatch.batchNumber,
        quantityRemaining: updatedBatch.quantityRemaining,
        quantitySold: updatedBatch.quantitySold,
        batchStatus: updatedBatch.batchStatus
      },
      ipAddress,
      userAgent,
      metadata: {
        triggeredBy: 'SALE',
        saleId,
        quantityAllocated: allocation.quantityAllocated
      }
    }, tx);

    // Create batch-sale tracking record
    const batchSale = await tx.warehouseBatchSale.create({
      data: {
        saleId,
        batchId: allocation.batchId,
        quantitySold: allocation.quantityAllocated
      }
    });

    batchSaleRecords.push({
      ...batchSale,
      batchNumber: allocation.batchNumber,
      expiryDate: allocation.expiryDate
    });
  }

  return batchSaleRecords;
}



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

    // ============================================================================
    // AUTO-FIX: Fix any batch integrity issues before recording sale
    // ============================================================================
    await autoFixBatchIntegrity(productId);

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

        const batchAllocations = await allocateSaleQuantityFEFO(
          tx, 
          productId, 
          quantity, 
          unitType
        );

        // ✅ ADD VALIDATION
        if (!batchAllocations || batchAllocations.length === 0) {
          throw new BusinessError(
            `Insufficient inventory for ${product.name}. Requested: ${quantity} ${unitType}`,
            'INSUFFICIENT_INVENTORY'
          );
        }

        console.log('📦 FEFO Allocations:', batchAllocations.map(b => ({
          batch: b.batchNumber,
          qty: b.quantityAllocated,
          expiry: b.expiryDate
        })));

        // Calculate SIMPLE AVERAGE cost from all active batches
        const averagePurchaseCost = await calculateSimpleAverageCost(tx, productId, unitType);
        const totalCostUsingAverage = parseFloat((averagePurchaseCost * quantity).toFixed(2));

        // ✅ ADD SAFETY CHECK
        if (totalCostUsingAverage === 0 || !isFinite(totalCostUsingAverage)) {
          console.error('❌ Invalid cost calculation:', {
            averagePurchaseCost,
            totalCostUsingAverage
          });
          throw new BusinessError(
            'Unable to calculate cost. Please check batch data.',
            'COST_CALCULATION_ERROR'
          );
        }

        // ✅ FINAL VALIDATION
        if (!isFinite(averagePurchaseCost)) {
          throw new BusinessError(
            'Invalid cost calculation result',
            'INVALID_COST'
          );
        }

        // Step 1: Create sale
        const warehouseSale = await tx.warehouseSale.create({
          data: {
            product: {
              connect: { id: productId }  // ✅ ADD THIS
            },
            quantity,
            unitType,
            unitPrice: price,
            totalAmount,
            costPerUnit: averagePurchaseCost,  // Simple average cost per unit
            totalCost: totalCostUsingAverage,  // Total cost using average
            grossProfit: totalAmount - totalCostUsingAverage,  // Revenue - Average Cost
            profitMargin: totalAmount > 0 ? ((totalAmount - totalCostUsingAverage) / totalAmount) * 100 : 0,
            paymentMethod: isCreditSale 
              ? (amountPaid > 0 ? initialPaymentMethod : null)
              : paymentMethod,            
            warehouseCustomer: warehouseCustomerId ? {  // ✅ Also connect customer if present
              connect: { id: warehouseCustomerId }
            } : undefined,
            customerName,
            customerPhone,
            receiptNumber,
            salesOfficerUser: {  // ✅ CHANGED FROM salesOfficer
              connect: { id: req.user.id }
            },
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

        // Step 4: Update batches (inventory is calculated from batches, not decremented directly)
        // ⚠️ IMPORTANT: We removed the direct inventory decrement to fix double-deduction bug
        // The batch system is the source of truth, inventory is synced from batches
        const { logInventoryChange, getRequestMetadata } = require('../utils/auditLogger');
        const metadata = getRequestMetadata(req);

        const batchSaleRecords = await updateBatchesAfterSale(
          tx,
          warehouseSale.id,
          batchAllocations,
          req.user.id,
          metadata.ipAddress,
          metadata.userAgent
        );

        console.log(`Sale used ${batchSaleRecords.length} batch(es)`)

        // Step 5: Auto-sync inventory from batches (ensures inventory is always accurate)
        // Calculate current stock from all active batches
        const allBatches = await tx.warehouseProductPurchase.findMany({
          where: {
            productId,
            batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
          }
        });

        // Sum up quantities by unit type
        const calculatedInventory = {
          pallets: 0,
          packs: 0,
          units: 0
        };

        allBatches.forEach(batch => {
          const remaining = batch.quantityRemaining || 0;
          if (batch.unitType === 'PALLETS') {
            calculatedInventory.pallets += remaining;
          } else if (batch.unitType === 'PACKS') {
            calculatedInventory.packs += remaining;
          } else if (batch.unitType === 'UNITS') {
            calculatedInventory.units += remaining;
          }
        });

        // Update inventory table to match batch calculations
        await tx.warehouseInventory.updateMany({
          where: { productId },
          data: {
            pallets: calculatedInventory.pallets,
            packs: calculatedInventory.packs,
            units: calculatedInventory.units,
            lastUpdated: new Date()
          }
        });

        console.log(`✅ Inventory auto-synced: P:${calculatedInventory.pallets} | Pk:${calculatedInventory.packs} | U:${calculatedInventory.units}`);

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

        // ============================================================================
        // FINAL INTEGRITY CHECK: Validate batch data before committing
        // This prevents any discrepancies from being persisted
        // ============================================================================
        const integrityCheck = await tx.$queryRaw`
          SELECT
            COUNT(*) as invalid_batches
          FROM warehouse_product_purchases
          WHERE product_id = ${productId}
            AND (
              quantity_remaining < 0
              OR quantity_sold < 0
              OR quantity_remaining + quantity_sold != quantity
            )
        `;

        if (integrityCheck[0]?.invalid_batches > 0) {
          throw new BusinessError(
            'Batch integrity check failed. Transaction rolled back.',
            'BATCH_INTEGRITY_ERROR'
          );
        }

        // Verify batch quantitySold matches the warehouseBatchSale records
        const batchSalesCheck = await tx.$queryRaw`
          SELECT
            wpp.id,
            wpp.quantity_sold as batch_qty_sold,
            COALESCE(SUM(wbs.quantity_sold), 0) as tracked_sales
          FROM warehouse_product_purchases wpp
          LEFT JOIN warehouse_batch_sales wbs ON wbs.batch_id = wpp.id
          WHERE wpp.product_id = ${productId}
          GROUP BY wpp.id, wpp.quantity_sold
          HAVING wpp.quantity_sold != COALESCE(SUM(wbs.quantity_sold), 0)
        `;

        if (batchSalesCheck.length > 0) {
          console.error('⚠️ Batch-sales mismatch detected:', batchSalesCheck);
          throw new BusinessError(
            'Batch-sales tracking mismatch. Transaction rolled back.',
            'BATCH_SALES_MISMATCH'
          );
        }

        console.log('✅✅✅ Transaction completed successfully (integrity verified)');
        return { warehouseSale, batchSaleRecords };
      });

    const result = await withReceiptConflictRetry(() => createSaleOperation());

    // ============================================================================
    // AUTO-SYNC INVENTORY (Ensure inventory matches batch data)
    // ============================================================================
    await syncProductInventory(productId, null, 'sale_creation');

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
      data: {
        sale: result.warehouseSale,
        batchesUsed: result.batchSaleRecords?.length || 0,
        batchDetails: result.batchSaleRecords?.map(b => ({
          batchNumber: b.batchNumber,
          quantity: b.quantitySold,
          expiryDate: b.expiryDate
        })) || []
      }
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
          },
          summary: {
            totalRevenue: 0,
            totalQuantitySold: 0,
            totalDiscounts: 0,
            totalSales: 0
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
          },
          summary: {
            totalRevenue: 0,
            totalQuantitySold: 0,
            totalDiscounts: 0,
            totalSales: total
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

    // Calculate summary statistics for ALL filtered sales (not just current page)
    const allFilteredSales = await prisma.warehouseSale.findMany({
      where: groupWhere,
      select: {
        totalAmount: true,
        quantity: true,
        totalDiscountAmount: true
      }
    });

    const summary = {
      totalRevenue: allFilteredSales.reduce((sum, sale) => sum + Number(sale.totalAmount || 0), 0),
      totalQuantitySold: allFilteredSales.reduce((sum, sale) => sum + Number(sale.quantity || 0), 0),
      totalDiscounts: allFilteredSales.reduce((sum, sale) => sum + Number(sale.totalDiscountAmount || 0), 0),
      totalSales: total
    };

    res.json({
      success: true,
      data: {
        sales: aggregatedSales,
        pagination: {
          page: pageNumber,
          limit: pageSize,
          total,
          totalPages: Math.ceil(total / pageSize)
        },
        summary
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

      // ✅ FIXED: Aggregate debtor info from ALL sales with this receipt
      if (sale.debtor) {
        if (!aggregatedSale.debtor) {
          // Initialize debtor object on first encounter
          aggregatedSale.debtor = {
            id: sale.debtor.id,
            amountPaid: 0,
            amountDue: 0,
            status: sale.debtor.status,
            dueDate: sale.debtor.dueDate
          };
        }

        // Accumulate amounts from all sales in this receipt
        aggregatedSale.debtor.amountPaid += Number(sale.debtor.amountPaid);
        aggregatedSale.debtor.amountDue += Number(sale.debtor.amountDue);

        // Update status to worst case (OVERDUE > PARTIAL > OUTSTANDING > PAID)
        const statusPriority = { 'OVERDUE': 4, 'PARTIAL': 3, 'OUTSTANDING': 2, 'PAID': 1 };
        const currentPriority = statusPriority[aggregatedSale.debtor.status] || 0;
        const salePriority = statusPriority[sale.debtor.status] || 0;
        if (salePriority > currentPriority) {
          aggregatedSale.debtor.status = sale.debtor.status;
        }
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


// @route   PUT /api/v1/warehouse/sales/:id
// @desc    Update warehouse sale (admin only)
// @access  Private (Warehouse Admin, Super Admin)
router.put('/sales/:id',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [
    param('id').custom(validateCuid('sale ID')),
    body('quantity').optional().isInt({ min: 1 }),
    body('unitPrice').optional().isFloat({ min: 0 }),
    body('customerName').optional().trim(),
    body('customerPhone').optional().trim(),
    body('notes').optional().trim(),
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = req.body;

    const existingSale = await prisma.warehouseSale.findUnique({
      where: { id },
      include: {
        product: true,
        warehouseBatchSales: true,
        debtor: true
      }
    });

    if (!existingSale) {
      throw new NotFoundError('Sale not found');
    }

    // Don't allow editing sales with outstanding debt
    if (existingSale.debtor && existingSale.debtor.amountDue > 0) {
      throw new BusinessError(
        'Cannot edit sale with outstanding debt. Clear debt first.',
        'OUTSTANDING_DEBT'
      );
    }

    // Recalculate totals if price or quantity changed
    if (updateData.quantity || updateData.unitPrice) {
      const quantity = updateData.quantity || existingSale.quantity;
      const unitPrice = updateData.unitPrice || existingSale.unitPrice;
      
      updateData.totalAmount = quantity * unitPrice;
      
      // Recalculate with discount if applicable
      if (existingSale.discountApplied && existingSale.discountPercentage) {
        const discountAmount = (updateData.totalAmount * existingSale.discountPercentage) / 100;
        updateData.totalDiscountAmount = discountAmount;
        updateData.totalAmount -= discountAmount;
      }

      // Recalculate profit
      const costPerUnit = existingSale.costPerUnit || 0;
      updateData.totalCost = quantity * costPerUnit;
      updateData.grossProfit = updateData.totalAmount - updateData.totalCost;
    }

    const updatedSale = await prisma.warehouseSale.update({
      where: { id },
      data: updateData,
      include: {
        product: true,
        salesOfficerUser: {
          select: { username: true }
        }
      }
    });

    res.json({
      success: true,
      message: 'Sale updated successfully',
      data: { sale: updatedSale }
    });
  })
);

// @route   DELETE /api/v1/warehouse/sales/:id
// @desc    Delete warehouse sale (reverse inventory and cash flow)
// @access  Private (Warehouse Admin, Super Admin)
router.delete('/sales/:id',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [
    param('id').custom(validateCuid('sale ID'))
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;

    const sale = await prisma.warehouseSale.findUnique({
      where: { id },
      include: {
        warehouseBatchSales: {
          include: {
            batch: true
          }
        },
        debtor: true
      }
    });

    if (!sale) {
      throw new NotFoundError('Sale not found');
    }

    // Check if sale has outstanding debt
    if (sale.debtor && sale.debtor.amountDue > 0) {
      throw new BusinessError(
        'Cannot delete sale with outstanding debt. Clear debt first.',
        'OUTSTANDING_DEBT'
      );
    }

    await prisma.$transaction(async (tx) => {
      // Get product info and inventory for logging
      const product = await tx.product.findUnique({
        where: { id: sale.productId },
        select: { name: true, productNo: true }
      });

      // 1. Reverse batch sales - add quantity back
      for (const batchSale of sale.warehouseBatchSales) {
        await tx.warehouseProductPurchase.update({
          where: { id: batchSale.batchId },
          data: {
            quantityRemaining: {
              increment: batchSale.quantitySold
            },
            quantitySold: {
              decrement: batchSale.quantitySold
            },
            batchStatus: 'ACTIVE'
          }
        });
      }

      // 2. Auto-sync inventory from batches (ensures inventory is always accurate)
      // Calculate current stock from all active batches
      const allBatches = await tx.warehouseProductPurchase.findMany({
        where: {
          productId: sale.productId,
          batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
        }
      });

      // Sum up quantities by unit type
      const calculatedInventory = {
        pallets: 0,
        packs: 0,
        units: 0
      };

      allBatches.forEach(batch => {
        const remaining = batch.quantityRemaining || 0;
        if (batch.unitType === 'PALLETS') {
          calculatedInventory.pallets += remaining;
        } else if (batch.unitType === 'PACKS') {
          calculatedInventory.packs += remaining;
        } else if (batch.unitType === 'UNITS') {
          calculatedInventory.units += remaining;
        }
      });

      // Update inventory table to match batch calculations
      await tx.warehouseInventory.updateMany({
        where: { productId: sale.productId },
        data: {
          pallets: calculatedInventory.pallets,
          packs: calculatedInventory.packs,
          units: calculatedInventory.units,
          lastUpdated: new Date()
        }
      });

      console.log(`✅ Inventory auto-synced after deletion: P:${calculatedInventory.pallets} | Pk:${calculatedInventory.packs} | U:${calculatedInventory.units}`);

      // 3. Log sale deletion
      const { logSaleChange, getRequestMetadata } = require('../utils/auditLogger');
      const { ipAddress, userAgent } = getRequestMetadata(req);

      await logSaleChange({
        userId: req.user.id,
        action: 'DELETE',
        saleId: id,
        oldSale: {
          receiptNumber: sale.receiptNumber,
          productId: sale.productId,
          productName: product?.name || 'Unknown',
          quantity: sale.quantity,
          unitType: sale.unitType,
          unitPrice: sale.unitPrice,
          totalAmount: sale.totalAmount,
          customerName: sale.customerName,
          customerPhone: sale.customerPhone
        },
        newSale: null,
        reason: `Sale deleted${sale.debtor ? ' (debt cleared)' : ''}`,
        ipAddress,
        userAgent
      }, tx);

      // 4. Delete batch sale records
      await tx.warehouseBatchSale.deleteMany({
        where: { saleId: id }
      });

      // 5. Delete debtor record if exists
      if (sale.debtor) {
        // Delete payments first
        await tx.debtorPayment.deleteMany({
          where: { debtorId: sale.debtor.id }
        });

        await tx.debtor.delete({
          where: { id: sale.debtor.id }
        });
      }

      // 6. Reverse cash flow entry if exists
      await tx.cashFlow.deleteMany({
        where: {
          module: 'WAREHOUSE',
          referenceNumber: sale.receiptNumber
        }
      });

      // 7. Delete the sale
      await tx.warehouseSale.delete({
        where: { id }
      });

      // ============================================================================
      // INTEGRITY CHECK: Verify batch data is valid after reversal
      // ============================================================================
      const integrityCheck = await tx.$queryRaw`
        SELECT COUNT(*) as invalid_batches
        FROM warehouse_product_purchases
        WHERE product_id = ${sale.productId}
          AND (
            quantity_remaining < 0
            OR quantity_sold < 0
            OR quantity_remaining + quantity_sold != quantity
          )
      `;

      if (integrityCheck[0]?.invalid_batches > 0) {
        throw new BusinessError(
          'Batch integrity check failed after deletion. Transaction rolled back.',
          'BATCH_INTEGRITY_ERROR'
        );
      }
    });

    // ============================================================================
    // FINAL AUTO-SYNC (Double-check inventory matches batch data)
    // ============================================================================
    await syncProductInventory(sale.productId, null, 'sale_deletion');

    res.json({
      success: true,
      message: 'Sale deleted successfully. Inventory has been restored.'
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
router.get(
  '/analytics/summary',
  authorizeModule('warehouse'),
  asyncHandler(async (req, res) => {
    const { startDate, endDate, filterMonth, filterYear } = req.query;

    // Determine date range
    const now = new Date();
    let rangeStart, rangeEnd;

    if (filterMonth && filterYear) {
      // 🔹 Specific month filter
      const month = parseInt(filterMonth);
      const year = parseInt(filterYear);
      rangeStart = new Date(year, month - 1, 1);
      rangeEnd = new Date(year, month, 0, 23, 59, 59, 999);
    } else if (filterYear) {
      // 🔹 Whole year filter
      const year = parseInt(filterYear);
      rangeStart = new Date(year, 0, 1);
      rangeEnd = new Date(year, 11, 31, 23, 59, 59, 999);
    } else if (startDate || endDate) {
      // 🔹 Custom range
      rangeStart = startDate ? new Date(startDate) : undefined;
      rangeEnd = endDate ? new Date(endDate) : undefined;
    } else {
      // 🔹 Default = current month
      rangeStart = new Date(now.getFullYear(), now.getMonth(), 1);
      rangeEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    }

    const dateFilter = {
      createdAt: {
        ...(rangeStart ? { gte: rangeStart } : {}),
        ...(rangeEnd ? { lte: rangeEnd } : {}),
      },
    };

    // Fetch sales with correct date range
    const [sales, debtorStats, customers, inventory, expenses, expensesByType, customerSales] = await Promise.all([
      prisma.warehouseSale.findMany({
        where: dateFilter,
        include: {
          product: true,
          warehouseCustomer: { select: { id: true, name: true } }
        },
      }),

      // 🆕 Debtor statistics (all-time, not date-filtered)
      // Note: Count unique customers with outstanding debt (not individual debtor records)
      // Each customer may have multiple debtor records (one per product in credit sale)
      prisma.debtor.groupBy({
        by: ['warehouseCustomerId'],
        where: {
          status: { in: ['OUTSTANDING', 'PARTIAL', 'OVERDUE'] },
          amountDue: { gt: 0 } // Only count customers with actual outstanding debt
        },
        _sum: {
          totalAmount: true,
          amountPaid: true,
          amountDue: true
        }
      }),

      prisma.warehouseCustomer.count(),

      prisma.warehouseInventory.findMany({
        include: { product: true }
      }),

      // 🆕 NEW: Warehouse expenses (approved only)
      prisma.warehouseExpense.aggregate({
        where: {
          expenseDate: dateFilter.createdAt,
          status: 'APPROVED'
        },
        _sum: {
          amount: true
        }
      }),

      // 🆕 NEW: Expense breakdown by type
      prisma.warehouseExpense.groupBy({
        by: ['expenseType'],
        where: {
          expenseDate: dateFilter.createdAt,
          status: 'APPROVED'
        },
        _sum: {
          amount: true
        }
      }),

      // 🆕 NEW: Customer sales aggregation
      prisma.warehouseSale.groupBy({
        by: ['warehouseCustomerId'],
        where: {
          ...dateFilter,
          warehouseCustomerId: { not: null }
        },
        _sum: {
          totalAmount: true,
          totalCost: true,
          grossProfit: true
        },
        _count: true
      })
    ]);

    // Calculate metrics
    let totalRevenue = 0;
    let totalCOGS = 0;
    let totalQuantitySold = 0;
    const productStats = {};

    for (const sale of sales) {
      const revenue = parseFloat(sale.totalAmount);
      const cost = parseFloat(sale.totalCost);

      totalRevenue += revenue;
      totalCOGS += cost;
      totalQuantitySold += sale.quantity;

      // Product statistics
      const productName = sale.product?.name || 'Unknown Product';
      if (!productStats[productName]) {
        productStats[productName] = {
          sales: 0,
          revenue: 0,
          cogs: 0,
          quantity: 0,
          grossProfit: 0
        };
      }
      productStats[productName].sales += 1;
      productStats[productName].revenue += revenue;
      productStats[productName].cogs += cost;
      productStats[productName].quantity += sale.quantity;
      productStats[productName].grossProfit += parseFloat(sale.grossProfit);
    }

    const grossProfit = totalRevenue - totalCOGS;
    const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    // 🆕 NEW: Net Profitability Calculations
    const totalExpenses = parseFloat(expenses._sum.amount || 0);
    const netProfit = grossProfit - totalExpenses;
    const netProfitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    // Cost ratios
    const cogsRatio = totalRevenue > 0 ? (totalCOGS / totalRevenue) * 100 : 0;
    const expenseRatio = totalRevenue > 0 ? (totalExpenses / totalRevenue) * 100 : 0;

    // Active customers count
    const activeCustomers = sales.length > 0 ? new Set(sales.map(s => s.warehouseCustomerId).filter(Boolean)).size : 0;

    // Efficiency metrics
    const averageSaleValue = sales.length > 0 ? totalRevenue / sales.length : 0;
    const revenuePerCustomer = activeCustomers > 0 ? totalRevenue / activeCustomers : 0;
    const profitPerSale = sales.length > 0 ? netProfit / sales.length : 0;

    // 🆕 NEW: Expense Breakdown by Category
    const expenseBreakdown = expensesByType.reduce((acc, item) => {
      const category = item.expenseType.toLowerCase();
      acc[category] = parseFloat(item._sum.amount || 0);
      return acc;
    }, {});

    // 🆕 NEW: Top Products with Net Profit (allocate expenses proportionally)
    const topProducts = Object.entries(productStats)
      .map(([name, stats]) => {
        const allocatedExpenses = totalRevenue > 0
          ? (stats.revenue / totalRevenue) * totalExpenses
          : 0;
        const netProfit = stats.grossProfit - allocatedExpenses;
        const netProfitMargin = stats.revenue > 0
          ? (netProfit / stats.revenue) * 100
          : 0;

        return {
          productName: name,
          sales: stats.sales,
          revenue: parseFloat(stats.revenue.toFixed(2)),
          cogs: parseFloat(stats.cogs.toFixed(2)),
          quantity: stats.quantity,
          grossProfit: parseFloat(stats.grossProfit.toFixed(2)),
          allocatedExpenses: parseFloat(allocatedExpenses.toFixed(2)),
          netProfit: parseFloat(netProfit.toFixed(2)),
          netProfitMargin: parseFloat(netProfitMargin.toFixed(2))
        };
      })
      .sort((a, b) => b.netProfit - a.netProfit)
      .slice(0, 10);

    // 🆕 NEW: Top Profitable Customers
    const profitableCustomers = await Promise.all(
      customerSales
        .map(async (customerSale) => {
          if (!customerSale.warehouseCustomerId) return null;

          const customer = await prisma.warehouseCustomer.findUnique({
            where: { id: customerSale.warehouseCustomerId },
            select: {
              id: true,
              name: true,
              outstandingDebt: true
            }
          });

          if (!customer) return null;

          const revenue = parseFloat(customerSale._sum.totalAmount || 0);
          const cogs = parseFloat(customerSale._sum.totalCost || 0);
          const grossProfit = parseFloat(customerSale._sum.grossProfit || 0);

          // Allocate expenses proportionally to this customer
          const allocatedExpenses = totalRevenue > 0
            ? (revenue / totalRevenue) * totalExpenses
            : 0;
          const netProfit = grossProfit - allocatedExpenses;
          const netProfitMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

          return {
            customerId: customer.id,
            customerName: customer.name,
            orderCount: customerSale._count,
            revenue: parseFloat(revenue.toFixed(2)),
            cogs: parseFloat(cogs.toFixed(2)),
            grossProfit: parseFloat(grossProfit.toFixed(2)),
            allocatedExpenses: parseFloat(allocatedExpenses.toFixed(2)),
            netProfit: parseFloat(netProfit.toFixed(2)),
            netProfitMargin: parseFloat(netProfitMargin.toFixed(2)),
            outstandingDebt: parseFloat(customer.outstandingDebt || 0)
          };
        })
    );

    const topCustomers = profitableCustomers
      .filter(c => c !== null)
      .sort((a, b) => b.netProfit - a.netProfit)
      .slice(0, 10);

    // ✅ FIXED: Calculate inventory metrics using PURCHASE COST
    let totalStockValue = 0;
    let lowStockItems = 0;
    let outOfStockItems = 0;

    for (const item of inventory) {
      const stockLevel = item.packs + (item.pallets * (item.product?.packsPerPallet || 1));
      
      // Get weighted average cost from active batches
      const activeBatches = await prisma.warehouseProductPurchase.findMany({
        where: {
          productId: item.productId,
          batchStatus: 'ACTIVE',
          quantityRemaining: { gt: 0 }
        },
        select: {
          costPerUnit: true,
          quantityRemaining: true
        }
      });
      
      let weightedAvgCost = 0;
      if (activeBatches.length > 0) {
        const totalCost = activeBatches.reduce((sum, batch) => 
          sum + (parseFloat(batch.costPerUnit) * batch.quantityRemaining), 0
        );
        const totalQty = activeBatches.reduce((sum, batch) => 
          sum + batch.quantityRemaining, 0
        );
        weightedAvgCost = totalQty > 0 ? totalCost / totalQty : 0;
      }
      
      const stockValue = stockLevel * weightedAvgCost;
      totalStockValue += stockValue;

      if (stockLevel === 0) {
        outOfStockItems++;
      } else if (stockLevel <= item.reorderLevel) {
        lowStockItems++;
      }
    }

    res.json({
      success: true,
      data: {
        summary: {
          // Revenue & Costs
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalCOGS: parseFloat(totalCOGS.toFixed(2)),
          totalExpenses: parseFloat(totalExpenses.toFixed(2)),

          // Profitability
          grossProfit: parseFloat(grossProfit.toFixed(2)),
          netProfit: parseFloat(netProfit.toFixed(2)),
          grossProfitMargin: parseFloat(profitMargin.toFixed(2)),
          netProfitMargin: parseFloat(netProfitMargin.toFixed(2)),

          // Cost Ratios
          cogsRatio: parseFloat(cogsRatio.toFixed(2)),
          expenseRatio: parseFloat(expenseRatio.toFixed(2)),

          // Sales Metrics
          totalSales: sales.length,
          totalQuantitySold,
          averageSaleValue: parseFloat(averageSaleValue.toFixed(2)),

          // Efficiency Metrics
          revenuePerCustomer: parseFloat(revenuePerCustomer.toFixed(2)),
          profitPerSale: parseFloat(profitPerSale.toFixed(2))
        },

        // 🆕 NEW: Expense Breakdown
        expenseBreakdown: {
          total: parseFloat(totalExpenses.toFixed(2)),
          byCategory: expenseBreakdown
        },

        debtorSummary: {
          totalDebtors: debtorStats.length || 0, // Count unique customers with outstanding debt
          totalOutstanding: parseFloat(debtorStats.reduce((sum, d) => sum + parseFloat(d._sum.amountDue || 0), 0).toFixed(2)),
          totalCreditSales: parseFloat(debtorStats.reduce((sum, d) => sum + parseFloat(d._sum.totalAmount || 0), 0).toFixed(2)),
          totalPaid: parseFloat(debtorStats.reduce((sum, d) => sum + parseFloat(d._sum.amountPaid || 0), 0).toFixed(2))
        },

        // Inventory summary (now using purchase cost)
        inventory: {
          totalStockValue: parseFloat(totalStockValue.toFixed(2)),
          totalItems: inventory.length,
          lowStockItems,
          outOfStockItems,
          stockHealthPercentage: inventory.length > 0
            ? parseFloat((((inventory.length - lowStockItems - outOfStockItems) / inventory.length) * 100).toFixed(2))
            : 100
        },

        // Customer summary
        customerSummary: {
          totalCustomers: customers,
          activeCustomers
        },

        // 🆕 ENHANCED: Top products now include net profit
        topProducts,

        // 🆕 NEW: Top profitable customers
        topCustomers,

        period: {
          startDate: rangeStart?.toISOString(),
          endDate: rangeEnd?.toISOString(),
          filterMonth,
          filterYear,
        },
      },
    });
  })
);



// @route   GET /api/v1/warehouse/analytics/profit-summary
// @desc    Get detailed profit summary with expense allocation
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

    // Fetch sales data and expenses in parallel
    const [profitByProduct, expenses, expensesByType] = await Promise.all([
      prisma.warehouseSale.groupBy({
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
      }),

      // Get total expenses
      prisma.warehouseExpense.aggregate({
        where: {
          expenseDate: where.createdAt || {},
          status: 'APPROVED'
        },
        _sum: {
          amount: true
        }
      }),

      // Get expense breakdown
      prisma.warehouseExpense.groupBy({
        by: ['expenseType'],
        where: {
          expenseDate: where.createdAt || {},
          status: 'APPROVED'
        },
        _sum: {
          amount: true
        }
      })
    ]);

    // Get product details
    const productIds = profitByProduct.map(p => p.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, productNo: true }
    });

    // Calculate totals
    const totalRevenue = profitByProduct.reduce((sum, item) => sum + parseFloat(item._sum.totalAmount || 0), 0);
    const totalCost = profitByProduct.reduce((sum, item) => sum + parseFloat(item._sum.totalCost || 0), 0);
    const totalGrossProfit = profitByProduct.reduce((sum, item) => sum + parseFloat(item._sum.grossProfit || 0), 0);
    const totalExpenses = parseFloat(expenses._sum.amount || 0);
    const totalNetProfit = totalGrossProfit - totalExpenses;

    // Build expense breakdown
    const expenseBreakdown = expensesByType.reduce((acc, item) => {
      const category = item.expenseType.toLowerCase();
      acc[category] = parseFloat(item._sum.amount || 0);
      return acc;
    }, {});

    // Allocate expenses proportionally to each product
    const profitAnalysis = profitByProduct.map(item => {
      const revenue = parseFloat(item._sum.totalAmount || 0);
      const cost = parseFloat(item._sum.totalCost || 0);
      const grossProfit = parseFloat(item._sum.grossProfit || 0);

      // Proportional expense allocation
      const allocatedExpenses = totalRevenue > 0
        ? (revenue / totalRevenue) * totalExpenses
        : 0;

      const netProfit = grossProfit - allocatedExpenses;
      const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
      const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

      return {
        product: products.find(p => p.id === item.productId),
        salesCount: item._count,
        totalQuantity: item._sum.quantity,
        revenue: parseFloat(revenue.toFixed(2)),
        cogs: parseFloat(cost.toFixed(2)),
        grossProfit: parseFloat(grossProfit.toFixed(2)),
        grossMargin: parseFloat(grossMargin.toFixed(2)),
        allocatedExpenses: parseFloat(allocatedExpenses.toFixed(2)),
        netProfit: parseFloat(netProfit.toFixed(2)),
        netMargin: parseFloat(netMargin.toFixed(2))
      };
    });

    // Sort by net profit (descending)
    profitAnalysis.sort((a, b) => b.netProfit - a.netProfit);

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalCOGS: parseFloat(totalCost.toFixed(2)),
          totalExpenses: parseFloat(totalExpenses.toFixed(2)),
          grossProfit: parseFloat(totalGrossProfit.toFixed(2)),
          netProfit: parseFloat(totalNetProfit.toFixed(2)),
          grossMargin: totalRevenue > 0
            ? parseFloat(((totalGrossProfit / totalRevenue) * 100).toFixed(2))
            : 0,
          netMargin: totalRevenue > 0
            ? parseFloat(((totalNetProfit / totalRevenue) * 100).toFixed(2))
            : 0,
          cogsRatio: totalRevenue > 0
            ? parseFloat(((totalCost / totalRevenue) * 100).toFixed(2))
            : 0,
          expenseRatio: totalRevenue > 0
            ? parseFloat(((totalExpenses / totalRevenue) * 100).toFixed(2))
            : 0
        },
        expenseBreakdown: {
          total: parseFloat(totalExpenses.toFixed(2)),
          byCategory: expenseBreakdown
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
    
    if (customerId) where.warehouseCustomerId = customerId;
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
        warehouseCustomer: { select: { name: true } },
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

    const { id: receiptNumber } = req.params;

const sale = await prisma.warehouseSale.findFirst({
  where: { receiptNumber },
  include: {
    product: true,
    warehouseCustomer: {
      select: {
        id: true,
        name: true,
        phone: true,
        address: true,
        customerType: true,
        businessName: true
      }
    },
    salesOfficerUser: { select: { username: true, role: true } }
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
