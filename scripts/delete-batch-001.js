const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('\n🗑️  DELETING BATCH 001 (35CL BIGI - Expiry: 12/01/2026)\n');
    console.log('='.repeat(80));

    const batchId = 'cmi902xh201odrg0q9bi6g4cq';

    // First, check if this batch has any sales linked to it
    const linkedSales = await prisma.warehouseBatchSale.findMany({
      where: { batchId },
      include: {
        warehouseSale: {
          include: {
            warehouseCustomer: true
          }
        }
      }
    });

    if (linkedSales.length > 0) {
      console.log(`⚠️  WARNING: This batch has ${linkedSales.length} sale(s) linked to it!\n`);
      linkedSales.forEach(bs => {
        const sale = bs.warehouseSale;
        const customer = sale.warehouseCustomer?.name || 'Walk-in';
        console.log(`   - Sale: ${sale.receiptNumber} (${customer})`);
        console.log(`     Quantity Sold: ${bs.quantitySold} PACKS`);
        console.log(`     Date: ${new Date(sale.createdAt).toLocaleDateString('en-GB')}`);
      });
      console.log('\n❌ CANNOT DELETE: Batch has linked sales.');
      console.log('   You must delete the sales first, or this will cause data integrity issues.\n');
      console.log('='.repeat(80));
      return;
    }

    // Get batch details before deletion
    const batch = await prisma.warehouseProductPurchase.findUnique({
      where: { id: batchId },
      include: {
        product: true
      }
    });

    if (!batch) {
      console.log('❌ Batch not found!');
      return;
    }

    console.log('📦 BATCH TO BE DELETED:\n');
    console.log(`   Product: ${batch.product.name}`);
    console.log(`   Product No: ${batch.product.productNo}`);
    console.log(`   Batch Number: ${batch.batchNumber}`);
    console.log(`   Quantity: ${batch.quantity} ${batch.unitType}`);
    console.log(`   Remaining: ${batch.quantityRemaining} ${batch.unitType}`);
    console.log(`   Sold: ${batch.quantitySold} ${batch.unitType}`);
    console.log(`   Expiry Date: ${new Date(batch.expiryDate).toLocaleDateString('en-GB')}`);
    console.log(`   Batch Status: ${batch.batchStatus}`);
    console.log('');

    // Check current inventory before deletion
    const inventoryBefore = await prisma.warehouseInventory.findFirst({
      where: { productId: batch.productId }
    });

    console.log('📊 CURRENT INVENTORY (35CL BIGI):');
    console.log(`   Packs: ${inventoryBefore?.packs || 0}`);
    console.log('');

    // Perform deletion in a transaction
    await prisma.$transaction(async (tx) => {
      // Delete the batch
      await tx.warehouseProductPurchase.delete({
        where: { id: batchId }
      });

      console.log('✅ Batch deleted successfully!\n');

      // Recalculate and sync inventory
      const allBatches = await tx.warehouseProductPurchase.findMany({
        where: {
          productId: batch.productId,
          batchStatus: { in: ['ACTIVE', 'DEPLETED'] },
          unitType: 'PACKS'
        }
      });

      const totalPacks = allBatches.reduce((sum, b) => sum + (b.quantityRemaining || 0), 0);

      await tx.warehouseInventory.updateMany({
        where: { productId: batch.productId },
        data: {
          packs: totalPacks,
          lastUpdated: new Date()
        }
      });

      console.log('📊 UPDATED INVENTORY (35CL BIGI):');
      console.log(`   Old Packs: ${inventoryBefore?.packs || 0}`);
      console.log(`   New Packs: ${totalPacks}`);
      console.log(`   Change: ${totalPacks - (inventoryBefore?.packs || 0)} packs`);
      console.log('');

      // Create audit log
      await tx.auditLog.create({
        data: {
          entity: 'WarehouseProductPurchase',
          entityId: batchId,
          action: 'DELETE',
          metadata: {
            productName: batch.product.name,
            productNo: batch.product.productNo,
            batchNumber: batch.batchNumber,
            quantity: batch.quantity,
            unitType: batch.unitType,
            expiryDate: batch.expiryDate,
            reason: 'Manual deletion - Unknown Product displayed on frontend',
            triggeredBy: 'Manual deletion script'
          }
        }
      });

      console.log('✅ Audit log created');
    });

    console.log('\n✅ BATCH DELETION COMPLETE!\n');
    console.log('='.repeat(80));

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
