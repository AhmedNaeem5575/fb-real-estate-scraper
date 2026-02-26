const cron = require('node-cron');
const scraper = require('./scraper');
const operationalControl = require('./operationalControl');
const logger = require('../utils/logger');

const INTERVAL_HOURS = parseInt(process.env.SCRAPE_INTERVAL_HOURS) || 4;

let scheduledTask = null;
let isRunning = false;
let isPaused = false;
let lastRun = null;
let lastRunError = null;
let nextRunTime = null;

function calculateNextRun() {
  const now = new Date();
  const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000;
  // Find next aligned time (every N hours at minute 0)
  const hours = now.getHours();
  const nextHour = Math.ceil((hours + 1) / INTERVAL_HOURS) * INTERVAL_HOURS;
  const next = new Date(now);
  next.setHours(nextHour, 0, 0, 0);
  if (next <= now) {
    next.setTime(next.getTime() + intervalMs);
  }
  return next;
}

function start() {
  // Cron expression for every N hours: '0 */N * * *'
  const cronExpression = `0 */${INTERVAL_HOURS} * * *`;

  logger.info(`Starting scheduler with ${INTERVAL_HOURS}-hour interval`);

  nextRunTime = calculateNextRun();

  scheduledTask = cron.schedule(cronExpression, async () => {
    logger.info('Scheduled scrape job triggered');

    // Check if paused
    if (isPaused) {
      logger.info('Scheduler is paused, skipping scrape job');
      return;
    }

    // Check operational status
    if (!operationalControl.canOperate()) {
      const state = operationalControl.getState();
      logger.warn(`Scrape job skipped - bot not authorized. Reason: ${state.reason || 'Unknown'}`);
      lastRunError = `Bot not authorized: ${state.reason || 'Unknown'}`;
      nextRunTime = calculateNextRun();
      return;
    }

    isRunning = true;
    lastRunError = null;
    try {
      await scraper.scrapeAllGroups();
      lastRun = new Date();
    } catch (error) {
      logger.error('Scheduled scrape job failed:', error.message);
      lastRunError = error.message;
    } finally {
      isRunning = false;
      nextRunTime = calculateNextRun();
    }
  });

  logger.info(`Scheduler started. Next run in ${INTERVAL_HOURS} hours.`);
}

function stop() {
  if (scheduledTask) {
    scheduledTask.stop();
    logger.info('Scheduler stopped');
  }
}

async function runNow() {
  if (isRunning) {
    throw new Error('Scrape already in progress');
  }

  // Check operational status for manual triggers too
  if (!operationalControl.canOperate()) {
    const state = operationalControl.getState();
    throw new Error(`Bot not authorized: ${state.reason || 'Unknown'}`);
  }

  logger.info('Manual scrape triggered');
  isRunning = true;
  lastRunError = null;

  try {
    await scraper.scrapeAllGroups();
    lastRun = new Date();
  } catch (error) {
    lastRunError = error.message;
    throw error;
  } finally {
    isRunning = false;
    nextRunTime = calculateNextRun();
  }
}

/**
 * Pause the scheduler (skip scheduled jobs)
 */
function pause() {
  isPaused = true;
  logger.info('Scheduler paused');
}

/**
 * Resume the scheduler
 */
function resume() {
  isPaused = false;
  logger.info('Scheduler resumed');
}

function getStatus() {
  const now = new Date();
  let timeUntilNext = null;

  if (nextRunTime && !isRunning) {
    timeUntilNext = Math.max(0, nextRunTime.getTime() - now.getTime());
  }

  return {
    isRunning,
    isPaused,
    canOperate: operationalControl.canOperate(),
    lastRun: lastRun ? lastRun.toISOString() : null,
    lastRunError,
    nextRun: nextRunTime ? nextRunTime.toISOString() : null,
    timeUntilNextMs: timeUntilNext,
    intervalHours: INTERVAL_HOURS
  };
}

module.exports = {
  start,
  stop,
  runNow,
  pause,
  resume,
  getStatus
};
