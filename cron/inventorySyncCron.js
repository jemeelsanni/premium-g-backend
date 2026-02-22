/**
 * Inventory Synchronization Cron Job
 *
 * Automatically scans and corrects inventory discrepancies every 5 minutes
 *
 * This ensures that even if something goes wrong, the system will
 * self-heal within 5 minutes.
 */

const cron = require('node-cron');
const { fullInventoryAudit, scanAndSyncAllProducts, validateBatchIntegrity } = require('../services/inventorySyncService');

let isRunning = false;

// Schedule: Run every 5 minutes for quick sync
const QUICK_SYNC_SCHEDULE = '*/5 * * * *'; // Every 5 minutes

// Schedule: Run full audit every hour (checks batch-sales consistency)
const FULL_AUDIT_SCHEDULE = '0 * * * *'; // Every hour at minute 0

// Schedule: Run comprehensive integrity check daily at 2 AM
const DAILY_INTEGRITY_SCHEDULE = '0 2 * * *'; // Daily at 2:00 AM

function startInventorySyncCron() {
  // Quick sync job - runs every 5 minutes (inventory <-> batch remaining)
  const quickSyncJob = cron.schedule(QUICK_SYNC_SCHEDULE, async () => {
    if (isRunning) {
      console.log('⏭️  Skipping inventory sync - previous run still in progress');
      return;
    }

    isRunning = true;

    try {
      await scanAndSyncAllProducts('scheduled_cron');
    } catch (error) {
      console.error('❌ Inventory sync cron error:', error.message);
    } finally {
      isRunning = false;
    }
  });

  // Full audit job - runs every hour (includes batch-sales consistency check)
  const fullAuditJob = cron.schedule(FULL_AUDIT_SCHEDULE, async () => {
    if (isRunning) {
      console.log('⏭️  Skipping full audit - previous run still in progress');
      return;
    }

    isRunning = true;

    try {
      await fullInventoryAudit('scheduled_hourly_audit');
    } catch (error) {
      console.error('❌ Full inventory audit cron error:', error.message);
    } finally {
      isRunning = false;
    }
  });

  // Daily integrity check - comprehensive validation at 2 AM
  const dailyIntegrityJob = cron.schedule(DAILY_INTEGRITY_SCHEDULE, async () => {
    if (isRunning) {
      console.log('⏭️  Skipping integrity check - previous run still in progress');
      return;
    }

    isRunning = true;

    try {
      console.log('\n🌙 Running daily integrity check...');
      const result = await validateBatchIntegrity();

      if (result.hasIssues) {
        console.log('⚠️  Daily integrity check found issues. Running full audit to fix...');
        await fullInventoryAudit('daily_integrity_fix');
      }
    } catch (error) {
      console.error('❌ Daily integrity check error:', error.message);
    } finally {
      isRunning = false;
    }
  });

  console.log('✅ Inventory auto-sync cron job started (quick sync every 5 minutes)');
  console.log('✅ Full inventory audit cron job started (batch-sales check every hour)');
  console.log('✅ Daily integrity check cron job started (comprehensive check at 2 AM)');

  return { quickSyncJob, fullAuditJob, dailyIntegrityJob };
}

module.exports = { startInventorySyncCron };
