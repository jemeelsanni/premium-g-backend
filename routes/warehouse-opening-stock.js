const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma'); // ✅ Use shared singleton
const { asyncHandler } = require('../middleware/errorHandler');
const { authorizeRole } = require('../middleware/auth');
const { query, validationResult } = require('express-validator');

// Use shared Prisma instance
/**
 * @route   GET /api/v1/warehouse/opening-stock
 * @desc    Get daily opening stock for products with date filtering and pagination
 * @access  Private (Warehouse Sales Manager, Admin, Sales Officer, Cashier)
 * 
 * Query Params:
 * - date: specific date (YYYY-MM-DD) - defaults to today
 * - productId: filter by specific product
 * - location: filter by warehouse location
 * - lowStockOnly: boolean - filter only low stock items
 * - page: page number (default: 1)
 * - limit: items per page (default: 20, max: 100)
 */
router.get(
  '/',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_SALES_OFFICER', 'CASHIER']),
  [
    query('date').optional().isISO8601().withMessage('Invalid date format'),
    query('productId').optional().isString(),
    query('location').optional().isString(),
    query('lowStockOnly').optional().isBoolean().toBoolean(),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt()
  ],
  asyncHandler(async (req, res) => {
    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { 
      date, 
      productId, 
      location, 
      lowStockOnly, 
      page = 1, 
      limit = 20 
    } = req.query;

    // Parse the target date - default to today
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0); // Start of day

    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Build product filter
    const productFilter = {};
    if (productId) productFilter.id = productId;
    if (location) productFilter.warehouseInventory = { some: { location } };

    // Get all products (before pagination)
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        module: 'WAREHOUSE',
        ...productFilter
      },
      include: {
        warehouseInventory: {
          where: location ? { location } : {}
        }
      },
      orderBy: {
        productNo: 'asc'
      }
    });

    // Calculate opening stock for each product
    const openingStockData = await Promise.all(
      products.map(async (product) => {
        // Get all transactions before the target date (for opening stock)
        // Only include ACTIVE and DEPLETED batches (exclude EXPIRED)
        const purchasesBeforeDate = await prisma.warehouseProductPurchase.findMany({
          where: {
            productId: product.id,
            purchaseDate: { lt: targetDate },
            batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
          },
          select: { quantity: true, unitType: true }
        });

        const salesBeforeDate = await prisma.warehouseSale.findMany({
          where: {
            productId: product.id,
            createdAt: { lt: targetDate }
          },
          select: { quantity: true, unitType: true }
        });

        // Get transactions ON the target date
        // Only include ACTIVE and DEPLETED batches (exclude EXPIRED)
        const purchasesOnDate = await prisma.warehouseProductPurchase.findMany({
          where: {
            productId: product.id,
            purchaseDate: { gte: targetDate, lte: endOfDay },
            batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
          },
          select: { quantity: true, unitType: true }
        });

        const salesOnDate = await prisma.warehouseSale.findMany({
          where: {
            productId: product.id,
            createdAt: { gte: targetDate, lte: endOfDay }
          },
          select: { quantity: true, unitPrice: true, totalAmount: true, unitType: true }
        });

        // Calculate movements on the date
        const totalSalesQuantity = salesOnDate.reduce((sum, sale) => {
          if (sale.unitType === 'PALLETS') return sum + (sale.quantity * (product.packsPerPallet || 1));
          if (sale.unitType === 'PACKS') return sum + sale.quantity;
          if (sale.unitType === 'UNITS') return sum + sale.quantity;
          return sum;
        }, 0);

        const totalSalesRevenue = salesOnDate.reduce((sum, sale) => sum + parseFloat(sale.totalAmount.toString()), 0);

        const totalPurchasesQuantity = purchasesOnDate.reduce((sum, purchase) => {
          if (purchase.unitType === 'PALLETS') return sum + (purchase.quantity * (product.packsPerPallet || 1));
          if (purchase.unitType === 'PACKS') return sum + purchase.quantity;
          if (purchase.unitType === 'UNITS') return sum + purchase.quantity;
          return sum;
        }, 0);

        // Get inventory location info and current stock (source of truth)
        const inventoryLocation = product.warehouseInventory[0]?.location || null;
        const reorderLevel = product.warehouseInventory[0]?.reorderLevel || 0;
        const currentPallets = product.warehouseInventory[0]?.pallets || 0;
        const currentPacks = product.warehouseInventory[0]?.packs || 0;
        const currentUnits = product.warehouseInventory[0]?.units || 0;

        // Use current inventory as closing stock (if today) or calculate from transactions
        const isToday = targetDate.toDateString() === new Date().toDateString();
        let closingStock, totalClosingStock;

        if (isToday) {
          // For today, use actual inventory as closing stock
          closingStock = {
            pallets: currentPallets,
            packs: currentPacks,
            units: currentUnits
          };
          totalClosingStock = (currentPallets * (product.packsPerPallet || 1)) + currentPacks + currentUnits;
        } else {
          // For past dates, calculate from transactions
          const allPurchases = [...purchasesBeforeDate, ...purchasesOnDate];
          const allSales = [...salesBeforeDate, ...salesOnDate];
          closingStock = calculateStock(allPurchases, allSales);
          totalClosingStock =
            (closingStock.pallets * (product.packsPerPallet || 1)) +
            closingStock.packs +
            closingStock.units;
        }

        // Calculate opening stock: Closing Stock + Sales Today - Purchases Today
        const totalOpeningStock = totalClosingStock + totalSalesQuantity - totalPurchasesQuantity;

        // Distribute opening stock across pallets/packs/units (simplified: keep as packs)
        const openingStock = {
          pallets: 0,
          packs: totalOpeningStock,
          units: 0
        };

        return {
          productId: product.id,
          productNo: product.productNo,
          productName: product.name,
          location: inventoryLocation,
          date: targetDate.toISOString().split('T')[0],
          
          openingStock: {
            pallets: openingStock.pallets,
            packs: openingStock.packs,
            units: openingStock.units,
            total: totalOpeningStock
          },
          
          movements: {
            salesQuantity: totalSalesQuantity,
            salesRevenue: parseFloat(totalSalesRevenue.toFixed(2)),
            purchasesQuantity: totalPurchasesQuantity,
            salesCount: salesOnDate.length,
            purchasesCount: purchasesOnDate.length
          },
          
          closingStock: {
            pallets: closingStock.pallets,
            packs: closingStock.packs,
            units: closingStock.units,
            total: totalClosingStock
          },
          
          variance: {
            pallets: closingStock.pallets - openingStock.pallets,
            packs: closingStock.packs - openingStock.packs,
            units: closingStock.units - openingStock.units,
            total: totalClosingStock - totalOpeningStock
          },
          
          reorderLevel,
          stockStatus: totalClosingStock <= reorderLevel ? 'LOW_STOCK' : 'NORMAL'
        };
      })
    );

    // Include all products (don't filter out products with zero activity)
    let filteredData = openingStockData;

    // Apply low stock filter if requested
    if (lowStockOnly === true) {
      filteredData = filteredData.filter(item => item.stockStatus === 'LOW_STOCK');
    }

    // Calculate summary statistics (from ALL filtered data, not just current page)
    const summary = {
      date: targetDate.toISOString().split('T')[0],
      totalProducts: filteredData.length,
      totalOpeningStock: filteredData.reduce((sum, item) => sum + item.openingStock.total, 0),
      totalClosingStock: filteredData.reduce((sum, item) => sum + item.closingStock.total, 0),
      totalSalesRevenue: filteredData.reduce((sum, item) => sum + item.movements.salesRevenue, 0),
      totalSalesQuantity: filteredData.reduce((sum, item) => sum + item.movements.salesQuantity, 0),
      totalPurchasesQuantity: filteredData.reduce((sum, item) => sum + item.movements.purchasesQuantity, 0),
      lowStockItems: filteredData.filter(item => item.stockStatus === 'LOW_STOCK').length
    };

    // Apply pagination
    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const totalItems = filteredData.length;
    const totalPages = Math.ceil(totalItems / limitNum);
    const skip = (pageNum - 1) * limitNum;
    
    const paginatedData = filteredData.slice(skip, skip + limitNum);

    res.json({
      success: true,
      data: {
        summary,
        openingStock: paginatedData,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total: totalItems,
          totalPages: totalPages
        }
      }
    });
  })
);

/**
 * @route   GET /api/v1/warehouse/opening-stock/history
 * @desc    Get historical opening stock data for date range
 * @access  Private (Warehouse Sales Manager, Admin)
 */
router.get(
  '/history',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN']),
  [
    query('startDate').isISO8601().withMessage('Start date is required'),
    query('endDate').isISO8601().withMessage('End date is required'),
    query('productId').optional().isString()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { startDate, endDate, productId } = req.query;

    const start = new Date(startDate);
    const end = new Date(endDate);

    // Generate array of dates
    const dates = [];
    const currentDate = new Date(start);
    while (currentDate <= end) {
      dates.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    if (productId) {
      // Get product details
      const product = await prisma.product.findUnique({
        where: { id: productId },
        include: {
          warehouseInventory: true
        }
      });

      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      // Calculate stock for each date
      const history = await Promise.all(
        dates.map(async (date) => {
          const endOfDay = new Date(date);
          endOfDay.setHours(23, 59, 59, 999);

          const purchases = await prisma.warehouseProductPurchase.findMany({
            where: {
              productId,
              purchaseDate: { lte: endOfDay },
              batchStatus: { in: ['ACTIVE', 'DEPLETED'] }
            },
            select: { quantity: true, unitType: true }
          });

          const sales = await prisma.warehouseSale.findMany({
            where: {
              productId,
              createdAt: { lte: endOfDay }
            },
            select: { quantity: true, unitType: true }
          });

          const openingStock = calculateStock(purchases, sales);
          const totalOpeningStock = 
            (openingStock.pallets * (product.packsPerPallet || 1)) + 
            openingStock.packs + 
            openingStock.units;

          return {
            date: date.toISOString().split('T')[0],
            openingStock: {
              pallets: openingStock.pallets,
              packs: openingStock.packs,
              units: openingStock.units,
              total: totalOpeningStock
            }
          };
        })
      );

      res.json({
        success: true,
        data: {
          product: {
            id: product.id,
            name: product.name,
            productNo: product.productNo
          },
          history
        }
      });
    } else {
      // Return summary for all products
      res.json({
        success: true,
        message: 'For historical data on all products, please query by specific date using the main endpoint',
        data: {
          dates,
          suggestion: 'Use GET /opening-stock?date=YYYY-MM-DD for each date'
        }
      });
    }
  })
);

/**
 * Helper function to calculate stock from transactions
 */
function calculateStock(purchases, sales) {
  const stock = { pallets: 0, packs: 0, units: 0 };

  // Add purchases
  purchases.forEach(purchase => {
    if (purchase.unitType === 'PALLETS') stock.pallets += purchase.quantity;
    else if (purchase.unitType === 'PACKS') stock.packs += purchase.quantity;
    else if (purchase.unitType === 'UNITS') stock.units += purchase.quantity;
  });

  // Subtract sales
  sales.forEach(sale => {
    if (sale.unitType === 'PALLETS') stock.pallets -= sale.quantity;
    else if (sale.unitType === 'PACKS') stock.packs -= sale.quantity;
    else if (sale.unitType === 'UNITS') stock.units -= sale.quantity;
  });

  return stock;
}

module.exports = router;