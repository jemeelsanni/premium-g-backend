/**
 * Delete VIJUMILK BIG from 25th February daily opening stock.
 * Run with: railway run node scripts/fix-vijumilk-opening-stock.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const VIJUMILK_BIG_ID = 'cmht35hew009jrg0q3usstxph';

async function fix() {
  // Target date: 25th February 2025
  const targetDate = new Date('2026-02-25T00:00:00.000Z');
  const nextDay = new Date('2026-02-26T00:00:00.000Z');

  // Find the record
  const record = await prisma.dailyOpeningStock.findFirst({
    where: {
      productId: VIJUMILK_BIG_ID,
      stockDate: {
        gte: targetDate,
        lt: nextDay
      }
    }
  });

  if (!record) {
    console.log('No daily opening stock record found for VIJUMILK BIG on 25th Feb');
    await prisma.$disconnect();
    return;
  }

  console.log('Found record:');
  console.log(`  ID: ${record.id}`);
  console.log(`  Date: ${record.stockDate}`);
  console.log(`  Manual packs: ${record.manualPacks}`);
  console.log(`  System packs: ${record.systemPacks}`);

  // Delete any edit requests linked to this record first
  await prisma.dailyOpeningStockEditRequest.deleteMany({
    where: { dailyOpeningStockId: record.id }
  });

  // Delete the record
  await prisma.dailyOpeningStock.delete({
    where: { id: record.id }
  });

  console.log('\nDeleted VIJUMILK BIG from 25th Feb manual count.');
  await prisma.$disconnect();
}

fix().catch(err => {
  console.error('Error:', err.message);
  prisma.$disconnect();
  process.exit(1);
});
