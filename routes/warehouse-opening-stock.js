const express = require('express');
const router = express.Router();
const { prisma } = require('../config/database');
const { asyncHandler } = require('../middleware/asyncHandler');
const { authorizeModule, authorizeRole } = require('../middleware/auth');
const { query } = require('express-validator');

/**
 * @route   GET /api/v1/warehouse/opening-stock
 * @desc    Get daily opening stock for products with date filtering
 * @access  Private (Warehouse Sales Manager, Admin)
 * 
 * Query Params:
 * - date: specific date (YYYY-MM-DD) - defaults to today
 * - productId: filter by specific product
 * - location: filter by warehouse location
 * - startDate: for date range queries
 * - endDate: for date range queries
 */
router.get(
  '/',
  authorizeRole(['SUPER_ADMIN', 'WAREHOUSE_ADMIN', 'WAREHOUSE_SALES_OFFICER']),
  [
    query('date').optional().isISO8601().withMessage('Invalid date format'),
    query('startDate').optional().isISO8601().withMessage('Invalid start date format'),
    query('endDate').optional().isISO8601().withMessage('Invalid end date format'),
    query('productId').optional().isString(),
    query('location').optional().isString()
  ],
  asyncHandler(async (req, res) => {
    const { date, productId, location, startDate, endDate } = req.query;

    // Parse the target date - default to today
    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0); // Start of day

    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Build product filter
    const productFilter = {};
    if (productId) productFilter.id = productId;
    if (location) productFilter.warehouseInventory = { some: { location } };

    // Get all products
    const products = await prisma.product.findMany({
      where: {
        isActive: true,
        module: 'WAREHOUSE',
        ...productFilter
      },
      include: {
        warehouseInventory: {
          where: location ? { location } : undefined
        }
      },
      orderBy: { name: 'asc' }
    });

    // Calculate opening stock for each product
    const openingStockData = await Promise.all(
      products.map(async (product) => {
        // Get all sales BEFORE the target date (this reduces the opening stock)
        const salesBeforeDate = await prisma.warehouseSale.findMany({
          where: {
            productId: product.id,
            createdAt: { lt: targetDate }
          },
          select: {
            quantity: true,
            unitType: true
          }
        });

        // Get all purchases BEFORE the target date (this increases the opening stock)
        const purchasesBeforeDate = await prisma.warehouseProductPurchase.findMany({
          where: {
            productId: product.id,
            purchaseDate: { lt: targetDate }
          },
          select: {
            quantity: true,
            unitType: true
          }
        });

        // Get sales ON the target date
        const salesOnDate = await prisma.warehouseSale.findMany({
          where: {
            productId: product.id,
            createdAt: { gte: targetDate, lte: endOfDay }
          },
          select: {
            quantity: true,
            unitType: true,
            totalAmount: true,
            createdAt: true
          }
        });

        // Get purchases ON the target date
        const purchasesOnDate = await prisma.warehouseProductPurchase.findMany({
          where: {
            productId: product.id,
            purchaseDate: { gte: targetDate, lte: endOfDay }
          },
          select: {
            quantity: true,
            unitType: true,
            totalCost: true,
            purchaseDate: true
          }
        });

        // Calculate opening stock (purchases - sales before target date)
        const openingStock = calculateStock(purchasesBeforeDate, salesBeforeDate);
        
        // Calculate closing stock (opening + purchases today - sales today)
        const closingStock = {
          pallets: openingStock.pallets + 
                   calculateStockByType(purchasesOnDate, 'PALLETS') - 
                   calculateStockByType(salesOnDate, 'PALLETS'),
          packs: openingStock.packs + 
                 calculateStockByType(purchasesOnDate, 'PACKS') - 
                 calculateStockByType(salesOnDate, 'PACKS'),
          units: openingStock.units + 
                 calculateStockByType(purchasesOnDate, 'UNITS') - 
                 calculateStockByType(salesOnDate, 'UNITS')
        };

        // Calculate total stock for comparison
        const totalOpeningStock = openingStock.pallets + openingStock.packs + openingStock.units;
        const totalClosingStock = closingStock.pallets + closingStock.packs + closingStock.units;
        const totalSalesQuantity = salesOnDate.reduce((sum, sale) => sum + sale.quantity, 0);
        const totalSalesRevenue = salesOnDate.reduce((sum, sale) => sum + parseFloat(sale.totalAmount), 0);
        const totalPurchasesQuantity = purchasesOnDate.reduce((sum, purchase) => sum + purchase.quantity, 0);

        // Get inventory location info
        const inventoryLocation = product.warehouseInventory[0]?.location || null;

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
          
          reorderLevel: product.warehouseInventory[0]?.reorderLevel || 0,
          stockStatus: totalClosingStock <= (product.warehouseInventory[0]?.reorderLevel || 0) 
            ? 'LOW_STOCK' 
            : 'NORMAL'
        };
      })
    );

    // Filter out products with zero opening stock if needed
    const filteredData = openingStockData.filter(item => item.openingStock.total > 0 || item.movements.salesQuantity > 0 || item.movements.purchasesQuantity > 0);

    // Calculate summary statistics
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

    res.json({
      success: true,
      data: {
        summary,
        openingStock: filteredData
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
    const { startDate, endDate, productId } = req.query;

    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // Get date range array
    const dates = [];
    const currentDate = new Date(start);
    while (currentDate <= end) {
      dates.push(new Date(currentDate).toISOString().split('T')[0]);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // If specific product requested
    if (productId) {
      const product = await prisma.product.findUnique({
        where: { id: productId },
        include: { warehouseInventory: true }
      });

      if (!product) {
        return res.status(404).json({
          success: false,
          message: 'Product not found'
        });
      }

      // Calculate opening stock for each date
      const history = await Promise.all(
        dates.map(async (date) => {
          const targetDate = new Date(date);
          targetDate.setHours(0, 0, 0, 0);
          
          const endOfDay = new Date(targetDate);
          endOfDay.setHours(23, 59, 59, 999);

          const salesBeforeDate = await prisma.warehouseSale.findMany({
            where: {
              productId,
              createdAt: { lt: targetDate }
            }
          });

          const purchasesBeforeDate = await prisma.warehouseProductPurchase.findMany({
            where: {
              productId,
              purchaseDate: { lt: targetDate }
            }
          });

          const openingStock = calculateStock(purchasesBeforeDate, salesBeforeDate);
          const totalOpeningStock = openingStock.pallets + openingStock.packs + openingStock.units;

          return {
            date,
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

/**
 * Helper function to calculate stock by specific unit type
 */
function calculateStockByType(transactions, unitType) {
  return transactions
    .filter(t => t.unitType === unitType)
    .reduce((sum, t) => sum + t.quantity, 0);
}

module.exports = router;