/**
 * Inventory Synchronization Cron Job
 *
 * Automatically scans and corrects inventory discrepancies every 5 minutes
 *
 * This ensures that even if something goes wrong, the system will
 * self-heal within 5 minutes.
 */

const cron = require('node-cron');
const { scanAndSyncAllProducts } = require('../services/inventorySyncService');

let isRunning = false;

// Schedule: Run every 5 minutes
const SCHEDULE = '*/5 * * * *'; // Every 5 minutes

function startInventorySyncCron() {
  // Schedule the cron job
  const job = cron.schedule(SCHEDULE, async () => {
    // Prevent overlapping runs
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

  console.log('✅ Inventory auto-sync cron job started (runs every 5 minutes)');

  return job;
}

module.exports = { startInventorySyncCron };
