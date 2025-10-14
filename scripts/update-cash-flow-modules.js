const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function updateCashFlowModules() {
  console.log('🔄 Updating existing cash flow entries...');

  try {
    // Update entries where module is null to WAREHOUSE (default)
    const warehouseResult = await prisma.cashFlow.updateMany({
      where: {
        module: null
      },
      data: {
        module: 'WAREHOUSE'
      }
    });

    console.log(`✅ Set ${warehouseResult.count} entries to WAREHOUSE`);
    
    // Update transport entries based on reference number pattern (TO-YYYY-XXXX)
    const transportResult = await prisma.cashFlow.updateMany({
      where: {
        referenceNumber: {
          startsWith: 'TO-'
        }
      },
      data: {
        module: 'TRANSPORT'
      }
    });

    console.log(`✅ Identified ${transportResult.count} TRANSPORT entries`);

    // Count final distribution
    const warehouseCount = await prisma.cashFlow.count({
      where: { module: 'WAREHOUSE' }
    });
    
    const transportCount = await prisma.cashFlow.count({
      where: { module: 'TRANSPORT' }
    });

    console.log('\n📊 Final Distribution:');
    console.log(`   Warehouse: ${warehouseCount} entries`);
    console.log(`   Transport: ${transportCount} entries`);
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

updateCashFlowModules();