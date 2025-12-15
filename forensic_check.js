const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function forensicInvestigation() {
  try {
    const product = await prisma.product.findFirst({
      where: {
        name: { contains: '35cl', mode: 'insensitive' },
        module: 'WAREHOUSE'
      },
      include: {
        warehouseInventory: true
      }
    });

    console.log('\n🔍 FORENSIC INVESTIGATION: 74 Missing Packs\n');
    console.log('Product ID:', product.id);
    console.log('Inventory ID:', product.warehouseInventory[0]?.id);

    // 1. Check for deleted sales via audit logs
    console.log('\n=== 1. CHECKING FOR DELETED SALES ===');
    const deletionLogs = await prisma.auditLog.findMany({
      where: {
        entity: 'WarehouseSale',
        action: 'DELETE',
        createdAt: {
          gte: new Date('2025-12-13T00:00:00'),
          lte: new Date('2025-12-15T23:59:59')
        }
      },
      include: {
        user: {
          select: { username: true, role: true, email: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    console.log('Deleted sales found:', deletionLogs.length);

    let totalDeletedPacks = 0;
    deletionLogs.forEach(log => {
      console.log('\n--- DELETED SALE ---');
      console.log('Deleted at:', log.createdAt);
      console.log('Deleted by:', log.user?.username, '(', log.user?.role, ')');
      console.log('User Email:', log.user?.email);
      console.log('IP Address:', log.ipAddress);

      if (log.oldValues && log.oldValues.productId === product.id) {
        console.log('⚠️ THIS WAS A 35CL BIGI SALE!');
        console.log('Receipt:', log.oldValues.receiptNumber);
        console.log('Quantity:', log.oldValues.quantity, log.oldValues.unitType);

        if (log.oldValues.unitType === 'PACKS') {
          totalDeletedPacks += log.oldValues.quantity;
        }

        console.log('Old Values:', JSON.stringify(log.oldValues, null, 2));
      }
    });

    if (totalDeletedPacks > 0) {
      console.log('\n❌ FOUND IT! Total deleted packs:', totalDeletedPacks);
      console.log('This explains', totalDeletedPacks, 'of the missing', 74, 'packs');
    }

    // 2. Check for manual inventory adjustments
    console.log('\n\n=== 2. CHECKING FOR MANUAL ADJUSTMENTS ===');
    const adjustmentLogs = await prisma.auditLog.findMany({
      where: {
        entity: 'WarehouseInventory',
        action: 'UPDATE',
        entityId: product.warehouseInventory[0]?.id,
        createdAt: {
          gte: new Date('2025-12-13T00:00:00'),
          lte: new Date('2025-12-15T23:59:59')
        }
      },
      include: {
        user: {
          select: { username: true, role: true }
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    console.log('Manual adjustment logs found:', adjustmentLogs.length);

    adjustmentLogs.forEach(log => {
      console.log('\n--- ADJUSTMENT ---');
      console.log('Date:', log.createdAt);
      console.log('User:', log.user?.username || 'SYSTEM');
      console.log('IP:', log.ipAddress);

      if (log.oldValues && log.newValues) {
        const oldPacks = log.oldValues.packs || 0;
        const newPacks = log.newValues.packs || 0;
        const difference = newPacks - oldPacks;

        console.log('Old Packs:', oldPacks);
        console.log('New Packs:', newPacks);
        console.log('Change:', difference > 0 ? '+' + difference : difference);
      }
    });

    // 3. Look for batch sale double-deduction bug
    console.log('\n\n=== 3. CHECKING FOR DOUBLE-DEDUCTION BUG ===');

    const dec15Sales = await prisma.warehouseSale.findMany({
      where: {
        productId: product.id,
        createdAt: {
          gte: new Date('2025-12-15T00:00:00'),
          lte: new Date('2025-12-15T23:59:59')
        }
      },
      include: {
        warehouseBatchSales: {
          include: {
            batch: true
          }
        }
      }
    });

    console.log('Sales on Dec 15:', dec15Sales.length);

    dec15Sales.forEach(sale => {
      const totalBatchQty = sale.warehouseBatchSales.reduce((sum, bs) => sum + bs.quantitySold, 0);
      console.log('\nSale:', sale.receiptNumber);
      console.log('  Sale Qty:', sale.quantity, sale.unitType);
      console.log('  Batch Qty:', totalBatchQty);
      console.log('  Batches Used:', sale.warehouseBatchSales.length);

      if (sale.warehouseBatchSales.length > 0) {
        sale.warehouseBatchSales.forEach(bs => {
          console.log('    -', bs.batch.batchNumber, ':', bs.quantitySold, 'packs');
        });
      }

      // Check if inventory was deducted twice (once for sale, once for batch)
      if (sale.warehouseBatchSales.length > 0 && totalBatchQty === sale.quantity) {
        console.log('  ⚠️ POTENTIAL DOUBLE-DEDUCTION: Sale qty matches batch qty');
        console.log('  If inventory was reduced by BOTH sale AND batch, stock is wrong!');
      }
    });

    // 4. Check inventory table for multiple records
    console.log('\n\n=== 4. CHECKING FOR DUPLICATE INVENTORY RECORDS ===');
    const allInventoryRecords = await prisma.warehouseInventory.findMany({
      where: {
        productId: product.id
      }
    });

    console.log('Inventory records for this product:', allInventoryRecords.length);

    if (allInventoryRecords.length > 1) {
      console.log('⚠️ MULTIPLE INVENTORY RECORDS FOUND!');
      allInventoryRecords.forEach((inv, index) => {
        console.log('\nRecord', index + 1);
        console.log('  ID:', inv.id);
        console.log('  Packs:', inv.packs);
        console.log('  Location:', inv.location);
        console.log('  Last Updated:', inv.lastUpdated);
      });
    }

    // 5. Timeline reconstruction
    console.log('\n\n=== 5. TIMELINE RECONSTRUCTION ===');

    const allEvents = [];

    // Get all sales
    const allSales = await prisma.warehouseSale.findMany({
      where: {
        productId: product.id,
        createdAt: {
          gte: new Date('2025-12-13T00:00:00'),
          lte: new Date('2025-12-15T23:59:59')
        }
      },
      orderBy: { createdAt: 'asc' }
    });

    allSales.forEach(sale => {
      allEvents.push({
        time: sale.createdAt,
        type: 'SALE',
        quantity: -(sale.unitType === 'PACKS' ? sale.quantity : 0),
        receipt: sale.receiptNumber
      });
    });

    // Get all purchases
    const allPurchases = await prisma.warehouseProductPurchase.findMany({
      where: {
        productId: product.id,
        purchaseDate: {
          gte: new Date('2025-12-13T00:00:00'),
          lte: new Date('2025-12-15T23:59:59')
        }
      },
      orderBy: { purchaseDate: 'asc' }
    });

    allPurchases.forEach(purchase => {
      allEvents.push({
        time: purchase.purchaseDate,
        type: 'PURCHASE',
        quantity: purchase.unitType === 'PACKS' ? purchase.quantity : 0,
        receipt: null
      });
    });

    // Sort by time
    allEvents.sort((a, b) => a.time - b.time);

    let runningStock = 2611; // Stock at beginning of Dec 13
    console.log('\nStarting stock (beginning of Dec 13):', runningStock);

    allEvents.forEach(event => {
      runningStock += event.quantity;
      const sign = event.quantity > 0 ? '+' : '';
      console.log(event.time.toISOString(), '-', event.type, ':', sign + event.quantity, '| Balance:', runningStock);
    });

    console.log('\nExpected final stock:', runningStock);
    console.log('Actual stock in DB:', product.warehouseInventory[0]?.packs);
    console.log('Discrepancy:', runningStock - product.warehouseInventory[0]?.packs);

  } catch (error) {
    console.error('Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

forensicInvestigation();
