/**
 * Script to clear all Daily Opening Stock data from the database
 * Run with: node scripts/clear-daily-opening-stock.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearDailyOpeningStock() {
  console.log('Starting to clear Daily Opening Stock data...\n');

  try {
    // 1. First delete edit requests (child table)
    const deletedEditRequests = await prisma.dailyOpeningStockEditRequest.deleteMany({});
    console.log(`Deleted ${deletedEditRequests.count} daily opening stock edit requests`);

    // 2. Then delete the main daily opening stock records
    const deletedOpeningStocks = await prisma.dailyOpeningStock.deleteMany({});
    console.log(`Deleted ${deletedOpeningStocks.count} daily opening stock records`);

    console.log('\n========================================');
    console.log('Daily Opening Stock data cleared successfully!');
    console.log('========================================\n');

  } catch (error) {
    console.error('Error clearing data:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
clearDailyOpeningStock()
  .then(() => {
    console.log('Script completed successfully.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Script failed:', error);
    process.exit(1);
  });
