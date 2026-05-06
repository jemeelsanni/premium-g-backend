const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const { asyncHandler, BusinessError, NotFoundError, ValidationError } = require('../middleware/errorHandler');
const { authorizeModule } = require('../middleware/auth');
const { logDataChange, getClientIP } = require('../middleware/auditLogger');
const { validateCuid } = require('../utils/validators');
const { generateTruckLoadNumber } = require('../utils/orderNumberGenerator');
const prisma = require('../lib/prisma');

const router = express.Router();

const MAX_PALLETS = 12;

// ── Shared include for truck load queries ──────────────────────────────────────
const truckLoadInclude = {
  supplierCompany: { select: { id: true, name: true, code: true } },
  createdByUser:   { select: { id: true, username: true } },
  orders: {
    include: {
      customer:   { select: { id: true, name: true, territory: true } },
      location:   { select: { id: true, name: true } },
      orderItems: { include: { product: { select: { id: true, name: true, productNo: true } } } }
    }
  }
};

// ── Helper: recalculate totalPallets for a truck load ─────────────────────────
const recalcTotalPallets = async (tx, truckLoadId) => {
  const orders = await tx.distributionOrder.findMany({
    where: { truckLoadId },
    select: { totalPallets: true }
  });
  const total = orders.reduce((sum, o) => sum + (o.totalPallets || 0), 0);
  await tx.truckLoad.update({ where: { id: truckLoadId }, data: { totalPallets: total } });
  return total;
};

// =============================================================================
// GET /truck-loads  — list all truck loads
// =============================================================================
router.get('/',
  authorizeModule('distribution'),
  asyncHandler(async (req, res) => {
    const { status, supplierCompanyId, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const where = {};
    if (status) where.status = status;
    if (supplierCompanyId) where.supplierCompanyId = supplierCompanyId;

    const [truckLoads, total] = await Promise.all([
      prisma.truckLoad.findMany({
        where,
        include: truckLoadInclude,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit)
      }),
      prisma.truckLoad.count({ where })
    ]);

    res.json({
      success: true,
      data: {
        truckLoads,
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

// =============================================================================
// POST /truck-loads  — create a new truck load
// =============================================================================
router.post('/',
  authorizeModule('distribution', 'write'),
  [
    body('supplierCompanyId').notEmpty().custom(validateCuid('supplier company ID')),
    body('orderIds').isArray({ min: 1 }).withMessage('At least one order ID is required'),
    body('orderIds.*').custom(validateCuid('order ID')),
    body('transporterCompany').optional().trim(),
    body('driverNumber').optional().trim(),
    body('truckNumber').optional().trim(),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ValidationError('Invalid input', errors.array());

    const { supplierCompanyId, orderIds, transporterCompany, driverNumber, truckNumber, notes } = req.body;

    // Validate supplier exists
    const supplier = await prisma.supplierCompany.findUnique({ where: { id: supplierCompanyId } });
    if (!supplier) throw new NotFoundError('Supplier company not found');

    // Fetch all orders
    const orders = await prisma.distributionOrder.findMany({
      where: { id: { in: orderIds } },
      select: { id: true, orderNumber: true, paymentStatus: true, status: true, supplierCompanyId: true, totalPallets: true, truckLoadId: true }
    });

    if (orders.length !== orderIds.length) {
      throw new NotFoundError('One or more orders not found');
    }

    // Validate each order
    for (const order of orders) {
      if (order.status === 'CANCELLED') {
        throw new BusinessError(`Order ${order.orderNumber} is cancelled`);
      }
      if (order.truckLoadId) {
        throw new BusinessError(`Order ${order.orderNumber} is already assigned to a truck load`);
      }
      if (order.supplierCompanyId !== supplierCompanyId) {
        throw new BusinessError(
          `Order ${order.orderNumber} belongs to a different supplier and cannot be grouped in this truck load`,
          'SUPPLIER_MISMATCH'
        );
      }
      if (order.paymentStatus === 'CONFIRMED' && order.status !== 'PENDING') {
        // Payment confirmed orders can still be grouped for logistics
      }
    }

    // Validate combined pallets
    const totalPallets = orders.reduce((sum, o) => sum + (o.totalPallets || 0), 0);
    if (totalPallets > MAX_PALLETS) {
      throw new BusinessError(
        `Combined pallets (${totalPallets}) exceed truck capacity of ${MAX_PALLETS}`,
        'TRUCK_CAPACITY_EXCEEDED'
      );
    }

    const loadNumber = await generateTruckLoadNumber();

    const truckLoad = await prisma.$transaction(async (tx) => {
      // Create truck load
      const load = await tx.truckLoad.create({
        data: {
          loadNumber,
          supplierCompanyId,
          status: 'PLANNED',
          totalPallets,
          transporterCompany: transporterCompany || null,
          driverNumber: driverNumber || null,
          truckNumber: truckNumber || null,
          notes: notes || null,
          createdBy: req.user.id
        },
        include: truckLoadInclude
      });

      // Link all orders to this truck load
      await tx.distributionOrder.updateMany({
        where: { id: { in: orderIds } },
        data: { truckLoadId: load.id }
      });

      // Audit
      logDataChange(req.user.id, 'TRUCK_LOAD', load.id, 'CREATE', null, {
        loadNumber,
        supplierCompanyId,
        totalPallets,
        orderCount: orderIds.length
      }, getClientIP(req)).catch(console.error);

      return load;
    });

    res.status(201).json({
      success: true,
      message: `Truck load ${loadNumber} created with ${orderIds.length} order(s) — ${totalPallets}/${MAX_PALLETS} pallets`,
      data: { truckLoad }
    });
  })
);

// =============================================================================
// GET /truck-loads/:id  — get single truck load with all orders
// =============================================================================
router.get('/:id',
  authorizeModule('distribution'),
  param('id').custom(validateCuid('truck load ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ValidationError('Invalid ID', errors.array());

    const truckLoad = await prisma.truckLoad.findUnique({
      where: { id: req.params.id },
      include: truckLoadInclude
    });
    if (!truckLoad) throw new NotFoundError('Truck load not found');

    res.json({ success: true, data: { truckLoad } });
  })
);

// =============================================================================
// PUT /truck-loads/:id  — update truck load details / status
// =============================================================================
router.put('/:id',
  authorizeModule('distribution', 'write'),
  param('id').custom(validateCuid('truck load ID')),
  [
    body('status').optional().isIn(['PLANNED', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED']),
    body('transporterCompany').optional().trim(),
    body('driverNumber').optional().trim(),
    body('truckNumber').optional().trim(),
    body('notes').optional().trim()
  ],
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ValidationError('Invalid input', errors.array());

    const truckLoad = await prisma.truckLoad.findUnique({ where: { id: req.params.id } });
    if (!truckLoad) throw new NotFoundError('Truck load not found');

    const { status, transporterCompany, driverNumber, truckNumber, notes } = req.body;

    // Validate status transition
    if (status && status !== truckLoad.status) {
      const allowed = {
        PLANNED:    ['IN_TRANSIT', 'CANCELLED'],
        IN_TRANSIT: ['COMPLETED', 'CANCELLED'],
        COMPLETED:  [],
        CANCELLED:  []
      };
      if (!allowed[truckLoad.status].includes(status)) {
        throw new BusinessError(
          `Cannot transition truck load from ${truckLoad.status} to ${status}`,
          'INVALID_STATUS_TRANSITION'
        );
      }
    }

    const updateData = {};
    if (status !== undefined) updateData.status = status;
    if (transporterCompany !== undefined) updateData.transporterCompany = transporterCompany || null;
    if (driverNumber !== undefined) updateData.driverNumber = driverNumber || null;
    if (truckNumber !== undefined) updateData.truckNumber = truckNumber || null;
    if (notes !== undefined) updateData.notes = notes || null;

    const updated = await prisma.truckLoad.update({
      where: { id: req.params.id },
      data: updateData,
      include: truckLoadInclude
    });

    logDataChange(req.user.id, 'TRUCK_LOAD', updated.id, 'UPDATE',
      { status: truckLoad.status }, updateData, getClientIP(req)).catch(console.error);

    res.json({ success: true, message: 'Truck load updated', data: { truckLoad: updated } });
  })
);

// =============================================================================
// POST /truck-loads/:id/orders  — add an order to an existing truck load
// =============================================================================
router.post('/:id/orders',
  authorizeModule('distribution', 'write'),
  param('id').custom(validateCuid('truck load ID')),
  body('orderId').notEmpty().custom(validateCuid('order ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ValidationError('Invalid input', errors.array());

    const { id: truckLoadId } = req.params;
    const { orderId } = req.body;

    const [truckLoad, order] = await Promise.all([
      prisma.truckLoad.findUnique({
        where: { id: truckLoadId },
        include: { orders: { select: { totalPallets: true } } }
      }),
      prisma.distributionOrder.findUnique({
        where: { id: orderId },
        select: { id: true, orderNumber: true, paymentStatus: true, status: true, supplierCompanyId: true, totalPallets: true, truckLoadId: true }
      })
    ]);

    if (!truckLoad) throw new NotFoundError('Truck load not found');
    if (!order) throw new NotFoundError('Order not found');

    if (truckLoad.status !== 'PLANNED') {
      throw new BusinessError(`Cannot add orders to a truck load that is ${truckLoad.status}`);
    }
    if (order.status === 'CANCELLED') {
      throw new BusinessError(`Order ${order.orderNumber} is cancelled`);
    }
    if (order.truckLoadId) {
      throw new BusinessError(`Order ${order.orderNumber} is already assigned to a truck load`);
    }
    if (order.supplierCompanyId !== truckLoad.supplierCompanyId) {
      throw new BusinessError(
        `Order ${order.orderNumber} belongs to a different supplier`,
        'SUPPLIER_MISMATCH'
      );
    }

    const currentPallets = truckLoad.orders.reduce((sum, o) => sum + (o.totalPallets || 0), 0);
    const newTotal = currentPallets + (order.totalPallets || 0);
    if (newTotal > MAX_PALLETS) {
      throw new BusinessError(
        `Adding this order (${order.totalPallets} pallets) would exceed truck capacity. Current: ${currentPallets}/${MAX_PALLETS}`,
        'TRUCK_CAPACITY_EXCEEDED'
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.distributionOrder.update({ where: { id: orderId }, data: { truckLoadId } });
      await recalcTotalPallets(tx, truckLoadId);
    });

    const updated = await prisma.truckLoad.findUnique({ where: { id: truckLoadId }, include: truckLoadInclude });

    res.json({
      success: true,
      message: `Order ${order.orderNumber} added to truck load ${truckLoad.loadNumber}. Combined: ${newTotal}/${MAX_PALLETS} pallets`,
      data: { truckLoad: updated }
    });
  })
);

// =============================================================================
// DELETE /truck-loads/:id/orders/:orderId  — remove an order from a truck load
// =============================================================================
router.delete('/:id/orders/:orderId',
  authorizeModule('distribution', 'write'),
  param('id').custom(validateCuid('truck load ID')),
  param('orderId').custom(validateCuid('order ID')),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) throw new ValidationError('Invalid input', errors.array());

    const { id: truckLoadId, orderId } = req.params;

    const [truckLoad, order] = await Promise.all([
      prisma.truckLoad.findUnique({ where: { id: truckLoadId } }),
      prisma.distributionOrder.findUnique({
        where: { id: orderId },
        select: { id: true, orderNumber: true, truckLoadId: true }
      })
    ]);

    if (!truckLoad) throw new NotFoundError('Truck load not found');
    if (!order) throw new NotFoundError('Order not found');
    if (order.truckLoadId !== truckLoadId) {
      throw new BusinessError(`Order ${order.orderNumber} is not part of this truck load`);
    }
    if (truckLoad.status !== 'PLANNED') {
      throw new BusinessError(`Cannot remove orders from a truck load that is ${truckLoad.status}`);
    }

    await prisma.$transaction(async (tx) => {
      await tx.distributionOrder.update({ where: { id: orderId }, data: { truckLoadId: null } });
      await recalcTotalPallets(tx, truckLoadId);
    });

    const updated = await prisma.truckLoad.findUnique({ where: { id: truckLoadId }, include: truckLoadInclude });

    res.json({
      success: true,
      message: `Order ${order.orderNumber} removed from truck load ${truckLoad.loadNumber}`,
      data: { truckLoad: updated }
    });
  })
);

module.exports = router;
