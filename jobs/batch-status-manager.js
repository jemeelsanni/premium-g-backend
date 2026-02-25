// jobs/batch-status-manager.js
// Automated batch status management
// Run this as a cron job (daily at midnight)

const prisma = require('../lib/prisma');

/**
 * Mark expired batches that haven't been updated yet
 */
async function markExpiredBatches() {
  const today = new Date();

  // First, find the batches that will be marked as expired
  const batchesToExpire = await prisma.warehouseProductPurchase.findMany({
    where: {
      expiryDate: {
        lt: today // Expiry date has passed
      },
      batchStatus: {
        not: 'EXPIRED' // Not already marked as expired
      }
    },
    include: {
      product: {
        select: { name: true, productNo: true }
      }
    }
  });

  // Update batches and create audit logs
  const { logBatchStatusChange } = require('../utils/auditLogger');

  for (const batch of batchesToExpire) {
    await prisma.warehouseProductPurchase.update({
      where: { id: batch.id },
      data: { batchStatus: 'EXPIRED' }
    });

    // Create audit log for each expired batch
    await logBatchStatusChange({
      userId: 'SYSTEM',
      action: 'AUTO_EXPIRE',
      batchId: batch.id,
      oldStatus: batch.batchStatus,
      newStatus: 'EXPIRED',
      reason: `Batch expired on ${batch.expiryDate?.toISOString().split('T')[0]} - Auto-marked by system`,
      quantityRemaining: batch.quantityRemaining,
      expiryDate: batch.expiryDate
    });

    console.log(`📦 Expired batch: ${batch.product?.name} (${batch.batchNumber || 'No batch #'}) - ${batch.quantityRemaining} remaining`);
  }

  console.log(`✅ Marked ${batchesToExpire.length} batches as EXPIRED`);
  return batchesToExpire.length;
}

/**
 * Clean up: Mark batches as DEPLETED if quantityRemaining is 0
 * (In case any were missed during sales transactions)
 */
async function markDepletedBatches() {
  const result = await prisma.warehouseProductPurchase.updateMany({
    where: {
      quantityRemaining: 0,
      batchStatus: 'ACTIVE'
    },
    data: {
      batchStatus: 'DEPLETED'
    }
  });

  console.log(`✅ Marked ${result.count} batches as DEPLETED`);
  return result.count;
}

/**
 * Generate expiry alerts for warehouse managers
 */
async function generateExpiryAlerts() {
  const today = new Date();
  const sixtyDaysFromNow = new Date();
  sixtyDaysFromNow.setDate(today.getDate() + 60);

  // Critical: Expiring within 60 days
  const criticalBatches = await prisma.warehouseProductPurchase.findMany({
    where: {
      expiryDate: {
        gte: today,
        lte: sixtyDaysFromNow
      },
      batchStatus: 'ACTIVE',
      quantityRemaining: { gt: 0 }
    },
    include: {
      product: {
        select: { name: true, productNo: true }
      }
    }
  });

  if (criticalBatches.length > 0) {
    console.log(`⚠️  CRITICAL: ${criticalBatches.length} batches expiring within 60 days`);
    // Log only a summary to reduce log volume
    // Individual batch details should be sent via email/SMS instead

    // TODO: Send email/SMS alerts to warehouse managers
    // await sendExpiryAlert(criticalBatches);
  }

  return criticalBatches;
}

/**
 * Main batch status management job
 */
async function manageBatchStatus() {
  console.log('🔄 Starting batch status management job...');
  
  try {
    const expiredCount = await markExpiredBatches();
    const depletedCount = await markDepletedBatches();
    const criticalAlerts = await generateExpiryAlerts();

    const summary = {
      timestamp: new Date().toISOString(),
      expiredBatches: expiredCount,
      depletedBatches: depletedCount,
      criticalAlerts: criticalAlerts.length
    };

    console.log('✅ Batch status management completed:', summary);
    return summary;

  } catch (error) {
    console.error('❌ Batch status management failed:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// If running as standalone script
if (require.main === module) {
  manageBatchStatus()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { manageBatchStatus, markExpiredBatches, generateExpiryAlerts };