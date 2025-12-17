/**
 * Test Daily Continuity Validation
 *
 * Quick test to verify that Opening Stock (Day N) = Closing Stock (Day N-1)
 */

const { validateDailyContinuity } = require('../services/inventorySyncService');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  try {
    console.log('\n📊 TESTING DAILY CONTINUITY VALIDATION\n');
    console.log('='.repeat(80));

    // Get a product to test
    const product = await prisma.product.findFirst({
      where: {
        warehouseInventory: { some: {} }
      },
      select: { id: true, name: true, productNo: true }
    });

    if (!product) {
      console.log('❌ No products found');
      return;
    }

    console.log(`📦 Testing with: ${product.name} (${product.productNo})\n`);

    // Test for today and yesterday
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    console.log('Testing Daily Continuity:\n');

    // Test: Yesterday's closing = Today's opening
    console.log('1️⃣  Yesterday → Today');
    const result1 = await validateDailyContinuity(product.id, today);
    console.log(`   Previous Day (${result1.previousDay}): Closing = ${result1.closingStockPreviousDay} packs`);
    console.log(`   Current Day (${result1.currentDay}): Opening = ${result1.openingStockCurrentDay} packs`);
    console.log(`   Match: ${result1.isValid ? '✅' : '❌'}`);
    if (!result1.isValid) {
      console.log(`   Discrepancy: ${result1.discrepancy} packs`);
    }
    console.log('');

    // Test: Two days ago closing = Yesterday's opening
    console.log('2️⃣  Two Days Ago → Yesterday');
    const result2 = await validateDailyContinuity(product.id, yesterday);
    console.log(`   Previous Day (${result2.previousDay}): Closing = ${result2.closingStockPreviousDay} packs`);
    console.log(`   Current Day (${result2.currentDay}): Opening = ${result2.openingStockCurrentDay} packs`);
    console.log(`   Match: ${result2.isValid ? '✅' : '❌'}`);
    if (!result2.isValid) {
      console.log(`   Discrepancy: ${result2.discrepancy} packs`);
    }
    console.log('');

    console.log('='.repeat(80));

    if (result1.isValid && result2.isValid) {
      console.log('✅ DAILY CONTINUITY VALIDATED!');
      console.log('   Opening stock always equals previous day\'s closing stock');
    } else {
      console.log('⚠️  CONTINUITY ISSUES DETECTED');
      if (!result1.isValid) {
        console.log(`   - Today's opening (${result1.openingStockCurrentDay}) != Yesterday's closing (${result1.closingStockPreviousDay})`);
      }
      if (!result2.isValid) {
        console.log(`   - Yesterday's opening (${result2.openingStockCurrentDay}) != Two days ago closing (${result2.closingStockPreviousDay})`);
      }
    }

    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
})();
