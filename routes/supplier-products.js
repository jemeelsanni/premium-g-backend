// routes/supplier-products.js
const express = require('express');
const { body, param, query } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { authenticateToken, authorizeModule } = require('../middleware/auth');
const { asyncHandler, ValidationError, NotFoundError } = require('../middleware/errorHandler');
const { validateCuid } = require('../utils/validators');

const router = express.Router();
const prisma = new PrismaClient();

// ==========================================
// SUPPLIER PRODUCTS MANAGEMENT
// ==========================================

/**
 * GET /api/v1/supplier-products
 * Get all supplier products with optional filters
 */
router.get(
  '/',
  authenticateToken,
  authorizeModule('distribution'),
  [
    query('supplierId').optional().custom(validateCuid('supplier ID')),
    query('productId').optional().custom(validateCuid('product ID')),
    query('availableOnly').optional().isBoolean().toBoolean(),
  ],
  asyncHandler(async (req, res) => {
    const { supplierId, productId, availableOnly } = req.query;

    const where = {};
    if (supplierId) where.supplierCompanyId = supplierId;
    if (productId) where.productId = productId;
    if (availableOnly === true) where.isAvailable = true;

    const supplierProducts = await prisma.supplierProduct.findMany({
      where,
      include: {
        supplierCompany: {
          select: {
            id: true,
            name: true,
            code: true,
            isActive: true,
          },
        },
        product: {
          select: {
            id: true,
            productNo: true,
            name: true,
            description: true,
            packsPerPallet: true,
            pricePerPack: true,
            isActive: true,
          },
        },
        categorySku: {
          include: { supplierCategory: true }
        },
      },
      orderBy: [
        { supplierCompany: { name: 'asc' } },
        { product: { name: 'asc' } },
      ],
    });

    res.json({
      success: true,
      data: supplierProducts,
    });
  })
);

/**
 * GET /api/v1/supplier-products/supplier/:supplierId
 * Get all products available from a specific supplier
 */
router.get(
  '/supplier/:supplierId',
  authenticateToken,
  authorizeModule('distribution'),
  param('supplierId').custom(validateCuid('supplier ID')),
  asyncHandler(async (req, res) => {
    const { supplierId } = req.params;
    const { availableOnly } = req.query;

    // Check if supplier exists
    const supplier = await prisma.supplierCompany.findUnique({
      where: { id: supplierId },
    });

    if (!supplier) {
      throw new NotFoundError('Supplier company not found');
    }

    const where = { supplierCompanyId: supplierId };
    if (availableOnly === 'true') where.isAvailable = true;

    const supplierProducts = await prisma.supplierProduct.findMany({
      where,
      include: {
        supplierCompany: {
          select: {
            id: true,
            name: true,
            code: true,
            isActive: true,
          },
        },
        product: {
          select: {
            id: true,
            productNo: true,
            name: true,
            description: true,
            packsPerPallet: true,
            pricePerPack: true,
            minSellingPrice: true,
            maxSellingPrice: true,
            isActive: true,
          },
        },
        categorySku: {
          include: { supplierCategory: true }
        },
      },
      orderBy: {
        product: { name: 'asc' },
      },
    });

    console.log(`[SUPPLIER PRODUCTS] Found ${supplierProducts.length} products for supplier ${supplierId}`);
    if (supplierProducts.length > 0) {
      console.log('[SUPPLIER PRODUCTS] First product:', JSON.stringify(supplierProducts[0], null, 2));
    }

    res.json({
      success: true,
      data: {
        supplier,
        products: supplierProducts,
      },
    });
  })
);

/**
 * GET /api/v1/supplier-products/:id
 * Get a specific supplier product by ID
 */
router.get(
  '/:id',
  authenticateToken,
  authorizeModule('distribution'),
  param('id').custom(validateCuid('supplier product ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const supplierProduct = await prisma.supplierProduct.findUnique({
      where: { id },
      include: {
        supplierCompany: true,
        product: true,
        categorySku: {
          include: { supplierCategory: true }
        },
      },
    });

    if (!supplierProduct) {
      throw new NotFoundError('Supplier product not found');
    }

    res.json({
      success: true,
      data: supplierProduct,
    });
  })
);

/**
 * GET /api/v1/supplier-products/:id/price-history
 * Get price change history for a supplier product
 */
router.get(
  '/:id/price-history',
  authenticateToken,
  authorizeModule('distribution'),
  param('id').custom(validateCuid('supplier product ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Check if supplier product exists
    const supplierProduct = await prisma.supplierProduct.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!supplierProduct) {
      throw new NotFoundError('Supplier product not found');
    }

    // Get price history
    const priceHistory = await prisma.supplierProductPriceHistory.findMany({
      where: { supplierProductId: id },
      include: {
        changedByUser: {
          select: {
            id: true,
            username: true,
            email: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    res.json({
      success: true,
      data: priceHistory,
    });
  })
);

/**
 * POST /api/v1/supplier-products
 * Add a product to a supplier's catalog
 */
router.post(
  '/',
  authenticateToken,
  authorizeModule('distribution', 'write'),
  [
    body('supplierCompanyId')
      .custom(validateCuid('supplier company ID'))
      .withMessage('Valid supplier company ID is required'),
    body('productId')
      .custom(validateCuid('product ID'))
      .withMessage('Valid product ID is required'),
    body('supplierCostPerPack')
      .isDecimal({ decimal_digits: '0,2' })
      .withMessage('Supplier cost per pack must be a valid decimal'),
    body('isAvailable')
      .optional()
      .isBoolean()
      .withMessage('isAvailable must be a boolean'),
    body('minimumOrderPacks')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Minimum order packs must be a positive integer'),
    body('leadTimeDays')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Lead time days must be a non-negative integer'),
    body('notes').optional().trim(),
  ],
  asyncHandler(async (req, res) => {
    const errors = require('express-validator').validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const {
      supplierCompanyId,
      productId,
      supplierCategorySkuId,
      supplierCostPerPack,
      isAvailable,
      minimumOrderPacks,
      leadTimeDays,
      notes,
    } = req.body;

    // Check if supplier exists
    const supplier = await prisma.supplierCompany.findUnique({
      where: { id: supplierCompanyId },
    });
    if (!supplier) {
      throw new NotFoundError('Supplier company not found');
    }

    // Check if product exists
    const product = await prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundError('Product not found');
    }

    // Check if this combination already exists
    const existing = await prisma.supplierProduct.findUnique({
      where: {
        supplierCompanyId_productId: {
          supplierCompanyId,
          productId,
        },
      },
    });

    if (existing) {
      throw new ValidationError(
        `Product "${product.name}" is already in ${supplier.name}'s catalog. Use update endpoint to modify.`
      );
    }

    // Create supplier product
    const supplierProduct = await prisma.supplierProduct.create({
      data: {
        supplierCompanyId,
        productId,
        supplierCategorySkuId: supplierCategorySkuId || null,
        supplierCostPerPack: parseFloat(supplierCostPerPack),
        isAvailable: isAvailable !== undefined ? isAvailable : true,
        minimumOrderPacks: minimumOrderPacks || null,
        leadTimeDays: leadTimeDays || null,
        notes: notes || null,
      },
      include: {
        supplierCompany: true,
        product: true,
        categorySku: {
          include: { supplierCategory: true }
        },
      },
    });

    res.status(201).json({
      success: true,
      message: `Product added to ${supplier.name}'s catalog successfully`,
      data: supplierProduct,
    });
  })
);

/**
 * PUT /api/v1/supplier-products/:id
 * Update a supplier product
 */
router.put(
  '/:id',
  authenticateToken,
  authorizeModule('distribution', 'write'),
  [
    param('id').custom(validateCuid('supplier product ID')),
    body('supplierCostPerPack')
      .optional()
      .isDecimal({ decimal_digits: '0,2' })
      .withMessage('Supplier cost per pack must be a valid decimal'),
    body('isAvailable')
      .optional()
      .isBoolean()
      .withMessage('isAvailable must be a boolean'),
    body('minimumOrderPacks')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Minimum order packs must be a positive integer'),
    body('leadTimeDays')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Lead time days must be a non-negative integer'),
    body('notes').optional().trim(),
    body('priceChangeReason').optional().trim(),
  ],
  asyncHandler(async (req, res) => {
    const errors = require('express-validator').validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { id } = req.params;
    const { supplierCostPerPack, isAvailable, minimumOrderPacks, leadTimeDays, notes, priceChangeReason } = req.body;

    // Check if exists
    const existing = await prisma.supplierProduct.findUnique({
      where: { id },
      include: {
        supplierCompany: true,
        product: true,
      },
    });

    if (!existing) {
      throw new NotFoundError('Supplier product not found');
    }

    // Build update data
    const updateData = {};
    let priceChanged = false;
    let oldPrice = null;
    let newPrice = null;

    if (supplierCostPerPack !== undefined) {
      newPrice = parseFloat(supplierCostPerPack);
      oldPrice = parseFloat(existing.supplierCostPerPack);

      // Check if price actually changed
      if (Math.abs(newPrice - oldPrice) > 0.01) {
        priceChanged = true;
        updateData.supplierCostPerPack = newPrice;
      }
    }
    if (isAvailable !== undefined) updateData.isAvailable = isAvailable;
    if (minimumOrderPacks !== undefined) updateData.minimumOrderPacks = minimumOrderPacks;
    if (leadTimeDays !== undefined) updateData.leadTimeDays = leadTimeDays;
    if (notes !== undefined) updateData.notes = notes;

    // Use transaction to update product and create price history
    const result = await prisma.$transaction(async (tx) => {
      // Update supplier product
      const supplierProduct = await tx.supplierProduct.update({
        where: { id },
        data: updateData,
        include: {
          supplierCompany: true,
          product: true,
          categorySku: {
            include: { supplierCategory: true }
          },
        },
      });

      // If price changed, create history record
      if (priceChanged) {
        await tx.supplierProductPriceHistory.create({
          data: {
            supplierProductId: id,
            oldPrice: oldPrice,
            newPrice: newPrice,
            changedBy: req.user.id,
            reason: priceChangeReason || null,
          },
        });
      }

      return supplierProduct;
    });

    res.json({
      success: true,
      message: priceChanged
        ? 'Supplier product updated successfully. Price change recorded.'
        : 'Supplier product updated successfully',
      data: result,
    });
  })
);

/**
 * DELETE /api/v1/supplier-products/:id
 * Remove a product from a supplier's catalog
 */
router.delete(
  '/:id',
  authenticateToken,
  authorizeModule('distribution', 'write'),
  param('id').custom(validateCuid('supplier product ID')),
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    const supplierProduct = await prisma.supplierProduct.findUnique({
      where: { id },
      include: {
        supplierCompany: { select: { name: true } },
        product: { select: { name: true } },
      },
    });

    if (!supplierProduct) {
      throw new NotFoundError('Supplier product not found');
    }

    await prisma.supplierProduct.delete({
      where: { id },
    });

    res.json({
      success: true,
      message: `${supplierProduct.product.name} removed from ${supplierProduct.supplierCompany.name}'s catalog`,
    });
  })
);

/**
 * POST /api/v1/supplier-products/bulk
 * Add multiple products to a supplier's catalog at once
 */
router.post(
  '/bulk',
  authenticateToken,
  authorizeModule('distribution', 'write'),
  [
    body('supplierCompanyId')
      .custom(validateCuid('supplier company ID'))
      .withMessage('Valid supplier company ID is required'),
    body('products')
      .isArray({ min: 1 })
      .withMessage('Products array is required with at least one product'),
    body('products.*.productId')
      .custom(validateCuid('product ID'))
      .withMessage('Valid product ID is required'),
    body('products.*.supplierCostPerPack')
      .isDecimal({ decimal_digits: '0,2' })
      .withMessage('Supplier cost per pack must be a valid decimal'),
  ],
  asyncHandler(async (req, res) => {
    const errors = require('express-validator').validationResult(req);
    if (!errors.isEmpty()) {
      throw new ValidationError('Invalid input data', errors.array());
    }

    const { supplierCompanyId, products } = req.body;

    // Check if supplier exists
    const supplier = await prisma.supplierCompany.findUnique({
      where: { id: supplierCompanyId },
    });
    if (!supplier) {
      throw new NotFoundError('Supplier company not found');
    }

    // Create all supplier products in a transaction
    const created = await prisma.$transaction(
      products.map((p) =>
        prisma.supplierProduct.upsert({
          where: {
            supplierCompanyId_productId: {
              supplierCompanyId,
              productId: p.productId,
            },
          },
          update: {
            supplierCostPerPack: parseFloat(p.supplierCostPerPack),
            isAvailable: p.isAvailable !== undefined ? p.isAvailable : true,
            minimumOrderPacks: p.minimumOrderPacks || null,
            leadTimeDays: p.leadTimeDays || null,
            notes: p.notes || null,
          },
          create: {
            supplierCompanyId,
            productId: p.productId,
            supplierCostPerPack: parseFloat(p.supplierCostPerPack),
            isAvailable: p.isAvailable !== undefined ? p.isAvailable : true,
            minimumOrderPacks: p.minimumOrderPacks || null,
            leadTimeDays: p.leadTimeDays || null,
            notes: p.notes || null,
          },
        })
      )
    );

    res.status(201).json({
      success: true,
      message: `${created.length} products added/updated for ${supplier.name}`,
      data: created,
    });
  })
);

module.exports = router;
