const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('\n🔍 SEARCHING FOR UNKNOWN PRODUCT BATCH\n');
    console.log('='.repeat(80));

    // Search criteria based on the details provided:
    // - Batch: 001
    // - Expiry Date: 12/01/2026 (Jan 12, 2026)
    // - Unit Type: PACKS

    const expiryDate = new Date('2026-01-12');

    // Search for batches matching the criteria
    const batches = await prisma.warehouseProductPurchase.findMany({
      where: {
        batchNumber: '001',
        expiryDate: expiryDate,
        unitType: 'PACKS'
      },
      include: {
        product: true
      }
    });

    console.log(`Found ${batches.length} batch(es) matching criteria:\n`);

    if (batches.length === 0) {
      console.log('❌ No batches found with:');
      console.log('   - Batch Number: 001');
      console.log('   - Expiry Date: 2026-01-12');
      console.log('   - Unit Type: PACKS');
      console.log('\nSearching with broader criteria...\n');

      // Try searching just by batch number
      const batchesByNumber = await prisma.warehouseProductPurchase.findMany({
        where: {
          batchNumber: '001'
        },
        include: {
          product: true
        }
      });

      console.log(`Found ${batchesByNumber.length} batch(es) with batch number "001":\n`);

      batchesByNumber.forEach(batch => {
        console.log(`📦 Batch ID: ${batch.id}`);
        console.log(`   Product: ${batch.product?.name || 'UNKNOWN'} (ID: ${batch.productId})`);
        console.log(`   Product No: ${batch.product?.productNo || 'N/A'}`);
        console.log(`   Batch Number: ${batch.batchNumber}`);
        console.log(`   Quantity: ${batch.quantity} ${batch.unitType}`);
        console.log(`   Remaining: ${batch.quantityRemaining} ${batch.unitType}`);
        console.log(`   Expiry Date: ${batch.expiryDate ? new Date(batch.expiryDate).toLocaleDateString('en-GB') : 'N/A'}`);
        console.log(`   Batch Status: ${batch.batchStatus}`);
        console.log(`   Purchase Date: ${new Date(batch.purchaseDate).toLocaleDateString('en-GB')}`);
        console.log('');
      });

      // Also search for products with null or undefined names
      const unknownProducts = await prisma.product.findMany({
        where: {
          OR: [
            { name: null },
            { name: '' },
            { productNo: null },
            { productNo: '' }
          ],
          module: 'WAREHOUSE'
        },
        include: {
          warehouseInventory: true
        }
      });

      if (unknownProducts.length > 0) {
        console.log('\n🔍 Found products with missing name/productNo:\n');
        unknownProducts.forEach(prod => {
          console.log(`   Product ID: ${prod.id}`);
          console.log(`   Name: "${prod.name || 'NULL'}"`);
          console.log(`   Product No: "${prod.productNo || 'NULL'}"`);
          console.log('');
        });
      }

    } else {
      batches.forEach(batch => {
        console.log(`📦 Batch ID: ${batch.id}`);
        console.log(`   Product: ${batch.product?.name || 'UNKNOWN'} (ID: ${batch.productId})`);
        console.log(`   Product No: ${batch.product?.productNo || 'N/A'}`);
        console.log(`   Batch Number: ${batch.batchNumber}`);
        console.log(`   Quantity: ${batch.quantity} ${batch.unitType}`);
        console.log(`   Remaining: ${batch.quantityRemaining} ${batch.unitType}`);
        console.log(`   Expiry Date: ${batch.expiryDate ? new Date(batch.expiryDate).toLocaleDateString('en-GB') : 'N/A'}`);
        console.log(`   Batch Status: ${batch.batchStatus}`);
        console.log(`   Purchase Date: ${new Date(batch.purchaseDate).toLocaleDateString('en-GB')}`);
        console.log('');
      });
    }

    // Search by expiry date alone
    console.log('\n🔍 Searching by expiry date (2026-01-12):\n');
    const batchesByExpiry = await prisma.warehouseProductPurchase.findMany({
      where: {
        expiryDate: {
          gte: new Date('2026-01-12T00:00:00Z'),
          lte: new Date('2026-01-12T23:59:59Z')
        }
      },
      include: {
        product: true
      }
    });

    console.log(`Found ${batchesByExpiry.length} batch(es) expiring on 2026-01-12:\n`);

    batchesByExpiry.forEach(batch => {
      console.log(`📦 Batch ID: ${batch.id}`);
      console.log(`   Product: ${batch.product?.name || 'UNKNOWN'} (ID: ${batch.productId})`);
      console.log(`   Product No: ${batch.product?.productNo || 'N/A'}`);
      console.log(`   Batch Number: ${batch.batchNumber}`);
      console.log(`   Quantity: ${batch.quantity} ${batch.unitType}`);
      console.log(`   Remaining: ${batch.quantityRemaining} ${batch.unitType}`);
      console.log(`   Expiry Date: ${new Date(batch.expiryDate).toLocaleDateString('en-GB')}`);
      console.log(`   Batch Status: ${batch.batchStatus}`);
      console.log('');
    });

    console.log('='.repeat(80));

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
