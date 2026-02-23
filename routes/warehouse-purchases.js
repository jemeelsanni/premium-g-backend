const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const { asyncHandler, ValidationError, BusinessError, NotFoundError } = require('../middleware/errorHandler');
const { authorizeModule } = require('../middleware/auth');
const { syncProductInventory } = require('../services/inventorySyncService');

// ================================
// CREATE WAREHOUSE PURCHASE
// ================================
router.post('/',
  authorizeModule('warehouse', 'write'),
  [
    body('productId').notEmpty().withMessage('Product ID is required'),
    body('vendorName').trim().notEmpty().withMessage('Vendor name is required'),
    body('vendorPhone').optional().trim(),
    body('vendorEmail').optional().isEmail(),
    body('orderNumber').optional().trim(),
    body('batchNumber').optional().trim(),
    body('expiryDate').optional().isISO8601(),
    body('quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
    body('unitType').isIn(['PALLETS', 'PACKS', 'UNITS']),
    body('costPerUnit').isFloat({ min: 0 }).withMessage('Cost must be positive'),
    body('paymentMethod').isIn(['CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'MOBILE_MONEY']),
    body('paymentStatus').optional().isIn(['PAID', 'PARTIAL', 'PENDING']),
    body('amountPaid').optional().isFloat({ min: 0 }),
    body('purchaseDate').isISO8601(),
    body('invoiceNumber').optional().trim(),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      productId,
      vendorName,
      vendorPhone,
      vendorEmail,
      orderNumber,
      batchNumber,
      expiryDate,
      quantity,
      unitType,
      costPerUnit,
      paymentMethod,
      paymentStatus = 'PAID',
      amountPaid,
      purchaseDate,
      invoiceNumber,
      notes
    } = req.body;

    // Calculate total cost
    const totalCost = parseFloat(costPerUnit) * parseInt(quantity);
    const paidAmount = amountPaid ? parseFloat(amountPaid) : (paymentStatus === 'PAID' ? totalCost : 0);
    const dueAmount = totalCost - paidAmount;

    // Check expiry date (alert if within 30 days)
    let expiryAlert = null;
    if (expiryDate) {
      const expiry = new Date(expiryDate);
      const today = new Date();
      const daysUntilExpiry = Math.ceil((expiry - today) / (1000 * 60 * 60 * 24));
      
      if (daysUntilExpiry <= 30 && daysUntilExpiry > 0) {
        expiryAlert = {
          message: `Warning: Product expires in ${daysUntilExpiry} days`,
          daysRemaining: daysUntilExpiry,
          expiryDate: expiry.toISOString()
        };
      } else if (daysUntilExpiry <= 0) {
        throw new BusinessError('Cannot purchase expired products', 'EXPIRED_PRODUCT');
      }
    }

    const initialBatchStatus = 'ACTIVE';


    // Use transaction to ensure atomic operations
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create purchase record
      const purchase = await tx.warehouseProductPurchase.create({
        data: {
          productId,
          vendorName,
          vendorPhone,
          vendorEmail,
          orderNumber,
          batchNumber,
          expiryDate: expiryDate ? new Date(expiryDate) : null,
          quantity: parseInt(quantity),
          unitType,
          quantityRemaining: parseInt(quantity),
          quantitySold: 0,
          batchStatus: initialBatchStatus,
          costPerUnit: parseFloat(costPerUnit),
          totalCost,
          paymentMethod,
          paymentStatus,
          amountPaid: paidAmount,
          amountDue: dueAmount,
          purchaseDate: new Date(purchaseDate),
          invoiceNumber,
          notes,
          createdBy: req.user.id
        },
        include: {
          product: {
            select: { name: true, productNo: true }
          },
          createdByUser: {
            select: { username: true, role: true }
          }
        }
      });

      // 2. Find or create inventory record
      let inventory = await tx.warehouseInventory.findFirst({
        where: { productId }
      });

      if (!inventory) {
        inventory = await tx.warehouseInventory.create({
          data: {
            productId,
            pallets: 0,
            packs: 0,
            units: 0,
            reorderLevel: 10
          }
        });
      }

      // Update inventory based on unit type
      const updates = {
        pallets: inventory.pallets,
        packs: inventory.packs,
        units: inventory.units
      };

      if (unitType === 'PALLETS') {
        updates.pallets += parseInt(quantity);
      } else if (unitType === 'PACKS') {
        updates.packs += parseInt(quantity);
      } else if (unitType === 'UNITS') {
        updates.units += parseInt(quantity);
      }

      await tx.warehouseInventory.update({
        where: { id: inventory.id },
        data: updates
      });

      // 3. ✨ CREATE CASH FLOW ENTRY (ONLY FOR PAID/PARTIAL PAYMENTS) ✨
      let cashFlowEntry = null;
      
      if (paymentStatus === 'PAID' || paymentStatus === 'PARTIAL') {
        const cashFlowDescription = `Purchase: ${purchase.product.name} (${quantity} ${unitType}) from ${vendorName}`;
        
        cashFlowEntry = await tx.cashFlow.create({
          data: {
            transactionType: 'CASH_OUT',
            amount: paidAmount,
            paymentMethod: paymentMethod,
            description: cashFlowDescription,
            referenceNumber: invoiceNumber || orderNumber || `PUR-${purchase.id.slice(-8)}`,
            cashier: req.user.id,
            module: 'WAREHOUSE'
          }
        });
        
        console.log('✅ Cash flow entry created for purchase:', {
          transactionType: 'CASH_OUT',
          amount: paidAmount,
          paymentMethod,
          purchaseId: purchase.id
        });
      }

      return { purchase, inventory: updates, expiryAlert, cashFlowEntry };
    });

    // ============================================================================
    // AUTO-SYNC INVENTORY (Ensure inventory matches batch data)
    // ============================================================================
    await syncProductInventory(productId, null, 'purchase_creation');

    const responseData = {
      success: true,
      message: 'Product purchase recorded, inventory updated, and cash flow tracked',
      data: result.purchase,
      cashFlowRecorded: result.cashFlowEntry !== null
    };

    if (result.expiryAlert) {
      responseData.warning = result.expiryAlert;
    }

    res.status(201).json(responseData);
  })
);

// ================================
// GET ALL PURCHASES
// ================================
router.get('/',
  authorizeModule('warehouse', 'read'),
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('productId').optional(),
    query('vendorName').optional().trim(),
    query('paymentStatus').optional().isIn(['PAID', 'PARTIAL', 'PENDING']),
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid query parameters', errors.array());
    }

    const {
      page = 1,
      limit = 20,
      productId,
      vendorName,
      paymentStatus,
      startDate,
      endDate
    } = req.query;

    const where = {};

    if (productId) where.productId = productId;
    if (vendorName)
      where.vendorName = { contains: vendorName, mode: 'insensitive' };
    if (paymentStatus) where.paymentStatus = paymentStatus;

    if (startDate || endDate) {
      where.purchaseDate = {};
      if (startDate) where.purchaseDate.gte = new Date(startDate);
      if (endDate) where.purchaseDate.lte = new Date(endDate);
    }

    const [purchases, total] = await Promise.all([
      prisma.warehouseProductPurchase.findMany({
        where,
        include: {
          product: { select: { name: true, productNo: true } },
          createdByUser: { select: { username: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip: (parseInt(page) - 1) * parseInt(limit),
        take: parseInt(limit)
      }),
      prisma.warehouseProductPurchase.count({ where })
    ]);

    const formattedPurchases = purchases.map(p => ({
      ...p,
      product: p.product || { name: 'Unknown Product', productNo: 'N/A' },
    }));

    res.json({
      success: true,
      data: {
        purchases: formattedPurchases,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  })
);



// ================================
// GET EXPIRING PRODUCTS (within 30 days)
// ================================
router.get('/expiring',
  authorizeModule('warehouse', 'read'),
  asyncHandler(async (req, res) => {
    const today = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(today.getDate() + 30);

    const expiringPurchases = await prisma.warehouseProductPurchase.findMany({
      where: {
        expiryDate: {
          gte: today,
          lte: thirtyDaysFromNow
        },
        batchStatus: 'ACTIVE',  // ✅ Only active batches
        quantityRemaining: { gt: 0 }  // ✅ Only items with remaining stock
      },
      include: {
        product: {
          select: { 
            name: true, 
            productNo: true,
            pricePerPack: true,  // ✅ Need price for revenue calculation
            costPerPack: true   // ✅ Need cost for value at risk
          }
        }
      },
      orderBy: { expiryDate: 'asc' }
    });

    // Calculate days until expiry and financial metrics for each batch
    const purchasesWithDetails = expiringPurchases.map(purchase => {
      const daysUntilExpiry = Math.ceil(
        (new Date(purchase.expiryDate) - today) / (1000 * 60 * 60 * 24)
      );

      // Calculate financial impact
      const valueAtRisk = purchase.quantityRemaining * parseFloat(purchase.costPerUnit);
      const potentialRevenue = purchase.quantityRemaining * parseFloat(purchase.product.pricePerPack || purchase.costPerUnit * 1.2);
      const percentageSold = purchase.quantity > 0 
        ? ((purchase.quantitySold / purchase.quantity) * 100).toFixed(1)
        : 0;

      return {
        id: purchase.id,
        productId: purchase.productId,
        // Include product as nested object for frontend compatibility
        product: {
          id: purchase.productId,
          name: purchase.product.name,
          productNo: purchase.product.productNo,
          pricePerPack: purchase.product.pricePerPack,
          costPerPack: purchase.product.costPerPack
        },
        // Also keep flat properties for backwards compatibility
        productName: purchase.product.name,
        productNo: purchase.product.productNo,
        batchNumber: purchase.batchNumber,
        orderNumber: purchase.orderNumber,
        expiryDate: purchase.expiryDate,
        quantity: purchase.quantity,
        originalQuantity: purchase.quantity,
        quantityRemaining: purchase.quantityRemaining,
        quantitySold: purchase.quantitySold,
        unitType: purchase.unitType,
        costPerUnit: purchase.costPerUnit,
        totalCost: purchase.totalCost,
        purchaseDate: purchase.purchaseDate,
        vendorName: purchase.vendorName,
        batchStatus: purchase.batchStatus,
        valueAtRisk,
        potentialRevenue,
        daysUntilExpiry,
        urgency: daysUntilExpiry <= 7 ? 'critical' : daysUntilExpiry <= 14 ? 'high' : 'medium',
        percentageSold: parseFloat(percentageSold)
      };
    });

    // ✅ Calculate summary statistics
    const summary = {
      totalBatchesExpiring: purchasesWithDetails.length,
      criticalBatches: purchasesWithDetails.filter(p => p.urgency === 'critical').length,
      highPriorityBatches: purchasesWithDetails.filter(p => p.urgency === 'high').length,
      totalValueAtRisk: purchasesWithDetails.reduce((sum, p) => sum + p.valueAtRisk, 0),
      totalPotentialRevenue: purchasesWithDetails.reduce((sum, p) => sum + p.potentialRevenue, 0)
    };

    res.json({
      success: true,
      data: {
        expiringPurchases: purchasesWithDetails,
        count: purchasesWithDetails.length,
        summary  // ✅ Now including summary
      }
    });
  })
);

// ================================
// GET PURCHASE ANALYTICS
// ================================
router.get('/analytics',
  authorizeModule('warehouse', 'read'),
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601()
  ],
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;

    const where = {};
    if (startDate || endDate) {
      where.purchaseDate = {};
      if (startDate) where.purchaseDate.gte = new Date(startDate);
      if (endDate) where.purchaseDate.lte = new Date(endDate);
    }

    const [summary, byProduct, byVendor, byPaymentStatus] = await Promise.all([
      // Overall summary
      prisma.warehouseProductPurchase.aggregate({
        where,
        _sum: {
          totalCost: true,
          amountPaid: true,
          amountDue: true
        },
        _count: true
      }),

      // Top products purchased
      prisma.warehouseProductPurchase.groupBy({
        by: ['productId'],
        where,
        _sum: {
          quantity: true,
          totalCost: true
        },
        _count: true,
        orderBy: {
          _sum: {
            totalCost: 'desc'
          }
        },
        take: 10
      }),

      // Top vendors
      prisma.warehouseProductPurchase.groupBy({
        by: ['vendorName'],
        where,
        _sum: {
          totalCost: true
        },
        _count: true,
        orderBy: {
          _sum: {
            totalCost: 'desc'
          }
        },
        take: 10
      }),

      // Payment status breakdown
      prisma.warehouseProductPurchase.groupBy({
        by: ['paymentStatus'],
        where,
        _sum: {
          totalCost: true,
          amountPaid: true,
          amountDue: true
        },
        _count: true
      })
    ]);

    // Fetch product details for top products
    const productIds = byProduct.map(p => p.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, productNo: true }
    });

    const productsMap = products.reduce((acc, p) => {
      acc[p.id] = p;
      return acc;
    }, {});

    const topProducts = byProduct.map(item => ({
      product: productsMap[item.productId],
      totalQuantity: item._sum.quantity,
      totalCost: item._sum.totalCost,
      purchaseCount: item._count
    }));

    res.json({
      success: true,
      data: {
        summary: {
          totalPurchases: summary._count,
          totalCost: summary._sum.totalCost || 0,
          totalPaid: summary._sum.amountPaid || 0,
          totalDue: summary._sum.amountDue || 0
        },
        topProducts,
        topVendors: byVendor.map(v => ({
          vendorName: v.vendorName,
          totalSpent: v._sum.totalCost,
          purchaseCount: v._count
        })),
        paymentBreakdown: byPaymentStatus
      }
    });
  })
);

// ================================
// GET SINGLE PURCHASE
// ================================
router.get('/:id',
  authorizeModule('warehouse', 'read'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const purchase = await prisma.warehouseProductPurchase.findUnique({
      where: { id },
      include: {
        product: true,
        createdByUser: {
          select: { username: true, role: true }
        }
      }
    });

    if (!purchase) {
      throw new NotFoundError('Purchase not found');
    }

    res.json({
      success: true,
      data: { purchase }
    });
  })
);

// ================================
// UPDATE PURCHASE
// ================================
router.put('/:id',
  authorizeModule('warehouse', 'admin'),
  [
    body('quantity').optional().isInt({ min: 1 }),
    body('costPerUnit').optional().isFloat({ min: 0 }),
    body('expiryDate').optional().isISO8601(),
    body('batchNumber').optional().trim(),
    body('vendorName').optional().trim(),
    body('paymentStatus').optional().isIn(['PAID', 'PARTIAL', 'PENDING']),
    body('amountPaid').optional().isFloat({ min: 0 })
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const updateData = { ...req.body };

    // Convert date strings to Date objects
    if (updateData.expiryDate) {
      updateData.expiryDate = new Date(updateData.expiryDate);
    }
    if (updateData.purchaseDate) {
      updateData.purchaseDate = new Date(updateData.purchaseDate);
    }

    const existingPurchase = await prisma.warehouseProductPurchase.findUnique({
      where: { id },
      include: {
        warehouseBatchSales: true
      }
    });

    if (!existingPurchase) {
      throw new NotFoundError('Purchase not found');
    }

    // Check if batch has been used in sales
    if (existingPurchase.warehouseBatchSales.length > 0 && updateData.quantity) {
      const totalSold = existingPurchase.quantitySold;
      if (updateData.quantity < totalSold) {
        throw new BusinessError(
          `Cannot reduce quantity below ${totalSold} - this amount has already been sold`,
          'QUANTITY_BELOW_SOLD'
        );
      }
    }

    // Recalculate if quantity or cost changed
    if (updateData.quantity || updateData.costPerUnit) {
      const quantity = updateData.quantity || existingPurchase.quantity;
      const costPerUnit = updateData.costPerUnit || existingPurchase.costPerUnit;
      
      updateData.totalCost = quantity * costPerUnit;
      updateData.quantityRemaining = quantity - existingPurchase.quantitySold;
      
      // Update batch status if needed
      if (updateData.quantityRemaining === 0) {
        updateData.batchStatus = 'DEPLETED';
      } else if (updateData.quantityRemaining > 0) {
        updateData.batchStatus = 'ACTIVE';
      }
    }

    // Recalculate payment if amounts changed
    if (updateData.amountPaid !== undefined || updateData.totalCost !== undefined) {
      const totalCost = updateData.totalCost || existingPurchase.totalCost;
      const amountPaid = updateData.amountPaid !== undefined ? updateData.amountPaid : existingPurchase.amountPaid;
      updateData.amountDue = totalCost - amountPaid;
    }

    const result = await prisma.$transaction(async (tx) => {
      // Update the purchase
      const updatedPurchase = await tx.warehouseProductPurchase.update({
        where: { id },
        data: updateData,
        include: {
          product: {
            select: { name: true, productNo: true }
          },
          createdByUser: {
            select: { username: true }
          }
        }
      });

      // If quantity changed, update inventory
      if (updateData.quantity && updateData.quantity !== existingPurchase.quantity) {
        const quantityDiff = updateData.quantity - existingPurchase.quantity;
        const inventory = await tx.warehouseInventory.findFirst({
          where: { productId: existingPurchase.productId }
        });

        if (inventory) {
          const oldInventoryState = {
            pallets: inventory.pallets,
            packs: inventory.packs,
            units: inventory.units
          };

          const updates = {};
          if (existingPurchase.unitType === 'PALLETS') {
            updates.pallets = inventory.pallets + quantityDiff;
          } else if (existingPurchase.unitType === 'PACKS') {
            updates.packs = inventory.packs + quantityDiff;
          } else if (existingPurchase.unitType === 'UNITS') {
            updates.units = inventory.units + quantityDiff;
          }

          const updatedInventory = await tx.warehouseInventory.update({
            where: { id: inventory.id },
            data: updates
          });

          // Log inventory change caused by purchase update
          const { logInventoryChange, getRequestMetadata } = require('../utils/auditLogger');
          const { ipAddress, userAgent } = getRequestMetadata(req);

          await logInventoryChange({
            userId: req.user.id,
            action: 'UPDATE',
            inventoryId: inventory.id,
            productId: existingPurchase.productId,
            productName: updatedPurchase.product.name,
            oldInventory: oldInventoryState,
            newInventory: {
              pallets: updatedInventory.pallets,
              packs: updatedInventory.packs,
              units: updatedInventory.units
            },
            reason: `Purchase quantity ${quantityDiff > 0 ? 'increased' : 'decreased'} by ${Math.abs(quantityDiff)} ${existingPurchase.unitType}`,
            triggeredBy: 'PURCHASE_UPDATE',
            referenceId: id,
            ipAddress,
            userAgent
          }, tx);
        }
      }

      // ✨ UPDATE CASH FLOW ENTRY IF PAYMENT DETAILS CHANGED ✨
      const paymentChanged = updateData.amountPaid !== undefined ||
                            updateData.paymentStatus !== undefined ||
                            updateData.totalCost !== undefined;

      if (paymentChanged) {
        const referenceNumber = existingPurchase.invoiceNumber ||
                               existingPurchase.orderNumber ||
                               `PUR-${id.slice(-8)}`;

        // Find existing cash flow entry
        const existingCashFlow = await tx.cashFlow.findFirst({
          where: {
            module: 'WAREHOUSE',
            referenceNumber: referenceNumber
          }
        });

        const newAmountPaid = updatedPurchase.amountPaid;
        const newPaymentStatus = updatedPurchase.paymentStatus;

        // Determine what to do with cash flow
        if (newPaymentStatus === 'PAID' || newPaymentStatus === 'PARTIAL') {
          // Should have a cash flow entry
          if (newAmountPaid > 0) {
            const cashFlowDescription = `Purchase: ${updatedPurchase.product.name} (${updatedPurchase.quantity} ${updatedPurchase.unitType}) from ${updatedPurchase.vendorName}`;

            if (existingCashFlow) {
              // Update existing cash flow entry
              await tx.cashFlow.update({
                where: { id: existingCashFlow.id },
                data: {
                  amount: newAmountPaid,
                  paymentMethod: updatedPurchase.paymentMethod,
                  description: cashFlowDescription
                }
              });
              console.log('✅ Cash flow entry updated for purchase:', {
                purchaseId: id,
                oldAmount: existingCashFlow.amount,
                newAmount: newAmountPaid
              });
            } else {
              // Create new cash flow entry (didn't exist before)
              await tx.cashFlow.create({
                data: {
                  transactionType: 'CASH_OUT',
                  amount: newAmountPaid,
                  paymentMethod: updatedPurchase.paymentMethod,
                  description: cashFlowDescription,
                  referenceNumber: referenceNumber,
                  cashier: req.user.id,
                  module: 'WAREHOUSE'
                }
              });
              console.log('✅ Cash flow entry created for updated purchase:', {
                purchaseId: id,
                amount: newAmountPaid
              });
            }
          }
        } else if (newPaymentStatus === 'PENDING') {
          // Should NOT have a cash flow entry (delete if exists)
          if (existingCashFlow) {
            await tx.cashFlow.delete({
              where: { id: existingCashFlow.id }
            });
            console.log('✅ Cash flow entry deleted for purchase (status changed to PENDING):', {
              purchaseId: id
            });
          }
        }
      }

      return updatedPurchase;
    });

    res.json({
      success: true,
      message: 'Purchase updated successfully',
      data: { purchase: result }
    });
  })
);

// ================================
// DELETE PURCHASE
// ================================
router.delete('/:id',
  authorizeModule('warehouse', 'admin'),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const purchase = await prisma.warehouseProductPurchase.findUnique({
      where: { id },
      include: {
        warehouseBatchSales: true
      }
    });

    if (!purchase) {
      throw new NotFoundError('Purchase not found');
    }

    // Cannot delete if batch has been used
    if (purchase.warehouseBatchSales.length > 0 || purchase.quantitySold > 0) {
      throw new BusinessError(
        'Cannot delete purchase - batch has been used in sales',
        'BATCH_IN_USE'
      );
    }

    await prisma.$transaction(async (tx) => {
      // Get product info for logging
      const product = await tx.product.findUnique({
        where: { id: purchase.productId },
        select: { name: true, productNo: true }
      });

      // Reverse inventory
      const inventory = await tx.warehouseInventory.findFirst({
        where: { productId: purchase.productId }
      });

      if (inventory) {
        const oldInventoryState = {
          pallets: inventory.pallets,
          packs: inventory.packs,
          units: inventory.units
        };

        const updates = {};
        if (purchase.unitType === 'PALLETS') {
          updates.pallets = Math.max(0, inventory.pallets - purchase.quantity);
        } else if (purchase.unitType === 'PACKS') {
          updates.packs = Math.max(0, inventory.packs - purchase.quantity);
        } else if (purchase.unitType === 'UNITS') {
          updates.units = Math.max(0, inventory.units - purchase.quantity);
        }

        const updatedInventory = await tx.warehouseInventory.update({
          where: { id: inventory.id },
          data: updates
        });

        // Log inventory change caused by purchase deletion
        const { logInventoryChange, getRequestMetadata } = require('../utils/auditLogger');
        const { ipAddress, userAgent } = getRequestMetadata(req);

        await logInventoryChange({
          userId: req.user.id,
          action: 'UPDATE',
          inventoryId: inventory.id,
          productId: purchase.productId,
          productName: product?.name || 'Unknown',
          oldInventory: oldInventoryState,
          newInventory: {
            pallets: updatedInventory.pallets,
            packs: updatedInventory.packs,
            units: updatedInventory.units
          },
          reason: `Purchase deleted - reversed ${purchase.quantity} ${purchase.unitType}`,
          triggeredBy: 'PURCHASE_DELETE',
          referenceId: id,
          ipAddress,
          userAgent
        }, tx);
      }

      // Log purchase deletion
      const { logPurchaseChange, getRequestMetadata } = require('../utils/auditLogger');
      const { ipAddress, userAgent } = getRequestMetadata(req);

      await logPurchaseChange({
        userId: req.user.id,
        action: 'DELETE',
        purchaseId: id,
        oldPurchase: {
          productId: purchase.productId,
          productName: product?.name || 'Unknown',
          vendorName: purchase.vendorName,
          quantity: purchase.quantity,
          unitType: purchase.unitType,
          totalCost: purchase.totalCost,
          batchNumber: purchase.batchNumber,
          expiryDate: purchase.expiryDate
        },
        newPurchase: null,
        reason: 'Purchase record deleted',
        ipAddress,
        userAgent
      }, tx);

      // Delete cash flow entry if exists
      await tx.cashFlow.deleteMany({
        where: {
          module: 'WAREHOUSE',
          referenceNumber: purchase.invoiceNumber || purchase.orderNumber || `PUR-${id.slice(-8)}`
        }
      });

      // Delete the purchase
      await tx.warehouseProductPurchase.delete({
        where: { id }
      });
    });

    // ============================================================================
    // AUTO-SYNC INVENTORY (Ensure inventory matches batch data)
    // ============================================================================
    await syncProductInventory(purchase.productId, null, 'purchase_deletion');

    res.json({
      success: true,
      message: 'Purchase deleted successfully. Inventory has been adjusted.'
    });
  })
);

module.exports = router;