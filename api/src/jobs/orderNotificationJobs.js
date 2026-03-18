const {
  processRetryBatch,
  runNotificationRetentionCleanup
} = require('../services/v1/ordersDomainService');

const SCHEDULER_ENABLED = String(process.env.ORDER_NOTIFY_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';
const SCHEDULER_INTERVAL_SECONDS = Math.max(10, Number(process.env.ORDER_NOTIFY_SCHEDULER_INTERVAL_SECONDS) || 20);
const RETENTION_ENABLED = String(process.env.ORDER_NOTIFY_RETENTION_ENABLED || 'true').toLowerCase() !== 'false';
const RETENTION_INTERVAL_HOURS = Math.max(1, Number(process.env.ORDER_NOTIFY_RETENTION_INTERVAL_HOURS) || 24);
const RETENTION_DAYS = Math.max(1, Number(process.env.ORDER_NOTIFY_RETENTION_DAYS) || 7);

let schedulerTimer = null;
let retentionTimer = null;
let schedulerInFlight = false;
let retentionInFlight = false;

async function executeRetryCycle() {
  if (schedulerInFlight) {
    return;
  }

  schedulerInFlight = true;
  try {
    const processed = await processRetryBatch();
    if (processed.length > 0) {
      console.log(`order-notify scheduler processed=${processed.length}`);
    }
  } catch (error) {
    console.error('order-notify scheduler error:', error.message);
  } finally {
    schedulerInFlight = false;
  }
}

async function executeRetentionCycle() {
  if (retentionInFlight) {
    return;
  }

  retentionInFlight = true;
  try {
    const deleted = await runNotificationRetentionCleanup(RETENTION_DAYS);
    if (deleted > 0) {
      console.log(`order-notify retention deleted=${deleted}`);
    }
  } catch (error) {
    console.error('order-notify retention error:', error.message);
  } finally {
    retentionInFlight = false;
  }
}

function startOrderNotificationJobs() {
  if (SCHEDULER_ENABLED) {
    schedulerTimer = setInterval(executeRetryCycle, SCHEDULER_INTERVAL_SECONDS * 1000);
    schedulerTimer.unref?.();
    executeRetryCycle().catch(() => {});
  }

  if (RETENTION_ENABLED) {
    retentionTimer = setInterval(executeRetentionCycle, RETENTION_INTERVAL_HOURS * 60 * 60 * 1000);
    retentionTimer.unref?.();
    executeRetentionCycle().catch(() => {});
  }
}

function stopOrderNotificationJobs() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
}

module.exports = {
  startOrderNotificationJobs,
  stopOrderNotificationJobs
};
