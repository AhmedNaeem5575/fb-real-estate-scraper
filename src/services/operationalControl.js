const cron = require('node-cron');
const externalApi = require('./externalApi');
const OperationalState = require('../models/OperationalState');
const logger = require('../utils/logger');

// Retry configuration
const DAILY_CHECK_RETRIES = 3;
const DAILY_CHECK_RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const PING_RETRIES = 3;
const PING_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes
const API_TIMEOUT_MS = 10000; // 10 seconds

class OperationalControlService {
  constructor() {
    this.state = null;
    this.dailyCheckJob = null;
    this.hourlyPingJob = null;
    this.isInitialized = false;
    this.scraper = null;
    this.scheduler = null;
  }

  /**
   * Initialize the service - load state from DB and start schedulers
   */
  async initialize() {
    if (this.isInitialized) {
      logger.warn('OperationalControl already initialized');
      return;
    }

    logger.info('Initializing OperationalControl service...');

    // Load state from database
    this.state = OperationalState.get();
    logger.info(`Loaded operational state: can_operate=${this.state.can_operate}, manual_blocked=${this.state.manual_blocked}, api_key_valid=${this.state.api_key_valid}`);

    this.isInitialized = true;
    logger.info('OperationalControl service initialized');
  }

  /**
   * Set references to scraper and scheduler for stop/resume operations
   */
  setDependencies(scraper, scheduler) {
    this.scraper = scraper;
    this.scheduler = scheduler;
  }

  /**
   * Get current operational status
   * Returns true if bot can operate, false otherwise
   */
  canOperate() {
    if (!this.state) {
      this.state = OperationalState.get();
    }

    // If manually blocked, cannot operate
    if (this.state.manual_blocked) {
      return false;
    }

    // If API key is invalid, use cached value
    if (!this.state.api_key_valid) {
      logger.info('API key invalid, using cached can_operate value');
      return Boolean(this.state.cached_can_operate);
    }

    return Boolean(this.state.can_operate);
  }

  /**
   * Get current state
   */
  getState() {
    if (!this.state) {
      this.state = OperationalState.get();
    }
    return {
      canOperate: Boolean(this.state.can_operate),
      manualBlocked: Boolean(this.state.manual_blocked),
      dailyEnabled: Boolean(this.state.daily_enabled),
      apiKeyValid: Boolean(this.state.api_key_valid),
      cachedCanOperate: Boolean(this.state.cached_can_operate),
      reason: this.state.reason,
      lastChecked: this.state.last_checked
    };
  }

  /**
   * Update internal state from database
   */
  refreshState() {
    this.state = OperationalState.get();
    return this.state;
  }

  /**
   * Check daily status from CRM (called at 01:00)
   * With retry logic: 3 attempts, 10min delay between retries
   */
  async checkDailyStatus() {
    logger.info('Starting daily status check...');

    for (let attempt = 1; attempt <= DAILY_CHECK_RETRIES; attempt++) {
      logger.info(`Daily status check attempt ${attempt}/${DAILY_CHECK_RETRIES}`);

      // Check if API key is still valid
      if (!this.state.api_key_valid) {
        logger.warn('API key marked as invalid, skipping daily check');
        return;
      }

      try {
        const result = await externalApi.getBotStatus();

        if (result.success) {
          const data = result.data;
          logger.info(`Daily status check successful: can_operate=${data.can_operate}`);

          // Update state
          this.state = OperationalState.update({
            can_operate: data.can_operate ? 1 : 0,
            daily_enabled: data.can_operate ? 1 : 0,
            daily_flag_date: new Date().toISOString().split('T')[0],
            reason: data.reason || null,
            last_checked: new Date().toISOString(),
            cached_can_operate: data.can_operate ? 1 : 0
          });

          // Resume or pause scheduler based on status
          if (data.can_operate) {
            logger.info('Daily check passed - bot authorized to operate');
            if (this.scheduler && this.scheduler.resume) {
              this.scheduler.resume();
            }
          } else {
            logger.warn('Daily check failed - bot not authorized (no credits)');
            if (this.scheduler && this.scheduler.pause) {
              this.scheduler.pause();
            }
          }

          return;
        }

        // Handle 401 Unauthorized
        if (result.isUnauthorized) {
          logger.error('Daily status check: API key unauthorized (401)');
          this.state = OperationalState.update({
            api_key_valid: 0,
            last_checked: new Date().toISOString()
          });
          return;
        }

        // Log error and retry
        logger.error(`Daily status check attempt ${attempt} failed:`, result.error);

      } catch (error) {
        logger.error(`Daily status check attempt ${attempt} error:`, error.message);
      }

      // Wait before retry (except last attempt)
      if (attempt < DAILY_CHECK_RETRIES) {
        logger.info(`Waiting ${DAILY_CHECK_RETRY_DELAY_MS / 60000} minutes before retry...`);
        await this.delay(DAILY_CHECK_RETRY_DELAY_MS);
      }
    }

    logger.error('Daily status check failed after all retries');
    // Keep current state on failure
  }

  /**
   * Ping CRM to detect manual blocks (called hourly)
   * With retry logic: 3 attempts, 5min delay between retries
   */
  async ping() {
    logger.info('Starting hourly ping...');

    for (let attempt = 1; attempt <= PING_RETRIES; attempt++) {
      logger.info(`Ping attempt ${attempt}/${PING_RETRIES}`);

      // Check if API key is still valid
      if (!this.state.api_key_valid) {
        logger.warn('API key marked as invalid, skipping ping');
        return;
      }

      try {
        const result = await externalApi.pingBot();

        if (result.success) {
          const data = result.data;
          logger.info(`Ping successful: can_operate=${data.can_operate}`);

          // Update state
          this.state = OperationalState.update({
            can_operate: data.can_operate ? 1 : 0,
            reason: data.reason || null,
            last_checked: new Date().toISOString(),
            cached_can_operate: data.can_operate ? 1 : 0
          });

          // If can_operate changed to false, stop the bot
          if (!data.can_operate) {
            logger.warn('Ping indicates bot should stop - requesting stop');
            this.requestStop();
            if (this.scheduler && this.scheduler.pause) {
              this.scheduler.pause();
            }
          }

          return;
        }

        // Handle 401 Unauthorized
        if (result.isUnauthorized) {
          logger.error('Ping: API key unauthorized (401)');
          this.state = OperationalState.update({
            api_key_valid: 0,
            last_checked: new Date().toISOString()
          });
          return;
        }

        // Log error and retry
        logger.error(`Ping attempt ${attempt} failed:`, result.error);

      } catch (error) {
        logger.error(`Ping attempt ${attempt} error:`, error.message);
      }

      // Wait before retry (except last attempt)
      if (attempt < PING_RETRIES) {
        logger.info(`Waiting ${PING_RETRY_DELAY_MS / 60000} minutes before retry...`);
        await this.delay(PING_RETRY_DELAY_MS);
      }
    }

    logger.error('Ping failed after all retries');
  }

  /**
   * Handle webhook events from CRM
   */
  handleWebhookEvent(event, data) {
    logger.info(`Handling webhook event: ${event}`);

    switch (event) {
      case 'midnight_credits_ok':
        // Daily check passed - bot can operate
        this.state = OperationalState.update({
          can_operate: 1,
          daily_enabled: 1,
          daily_flag_date: new Date().toISOString().split('T')[0],
          reason: null,
          cached_can_operate: 1
        });
        logger.info('Webhook: midnight_credits_ok - bot authorized to operate');
        if (this.scheduler && this.scheduler.resume) {
          this.scheduler.resume();
        }
        break;

      case 'midnight_no_credits':
        // Daily check failed - no credits
        this.state = OperationalState.update({
          can_operate: 0,
          daily_enabled: 0,
          daily_flag_date: new Date().toISOString().split('T')[0],
          reason: data.reason || 'No credits available',
          cached_can_operate: 0
        });
        logger.warn('Webhook: midnight_no_credits - bot not authorized');
        this.requestStop();
        if (this.scheduler && this.scheduler.pause) {
          this.scheduler.pause();
        }
        break;

      case 'manual_block':
        // Admin manually blocked the bot
        this.state = OperationalState.update({
          manual_blocked: 1,
          reason: data.reason || 'Manually blocked by admin',
          cached_can_operate: 0
        });
        logger.warn('Webhook: manual_block - bot manually blocked');
        this.requestStop();
        if (this.scheduler && this.scheduler.pause) {
          this.scheduler.pause();
        }
        break;

      case 'manual_unblock':
        // Admin manually unblocked the bot
        this.state = OperationalState.update({
          manual_blocked: 0,
          reason: null
        });
        logger.info('Webhook: manual_unblock - bot unblocked');
        // Check if we can resume (depends on can_operate)
        if (this.state.can_operate && this.scheduler && this.scheduler.resume) {
          this.scheduler.resume();
        }
        break;

      case 'manual_unblock_no_credits':
        // Admin unblocked but no credits
        this.state = OperationalState.update({
          manual_blocked: 0,
          can_operate: 0,
          reason: data.reason || 'Unblocked but no credits',
          cached_can_operate: 0
        });
        logger.info('Webhook: manual_unblock_no_credits - unblocked but cannot operate');
        break;

      case 'evening_credits_available':
        // Credits became available in the evening (informational)
        logger.info('Webhook: evening_credits_available - credits now available');
        // Could optionally update state here if we want to resume
        break;

      default:
        logger.warn(`Webhook: unknown event type: ${event}`);
    }

    return { handled: true, event };
  }

  /**
   * Request scraper to stop
   */
  requestStop() {
    if (this.scraper && this.scraper.requestStop) {
      logger.info('Requesting scraper to stop...');
      this.scraper.requestStop();
    }
  }

  /**
   * Start daily status check cron job (runs at 01:00)
   */
  startDailyCheck() {
    if (this.dailyCheckJob) {
      logger.warn('Daily check job already running');
      return;
    }

    // Run at 01:00 every day
    this.dailyCheckJob = cron.schedule('0 1 * * *', async () => {
      logger.info('Daily status check cron triggered');
      await this.checkDailyStatus();
    }, {
      scheduled: true,
      timezone: 'Europe/Rome'
    });

    logger.info('Daily status check scheduled at 01:00 (Europe/Rome)');
  }

  /**
   * Start hourly ping cron job
   */
  startHourlyPing() {
    if (this.hourlyPingJob) {
      logger.warn('Hourly ping job already running');
      return;
    }

    // Run at minute 0 of every hour
    this.hourlyPingJob = cron.schedule('0 * * * *', async () => {
      logger.info('Hourly ping cron triggered');
      await this.ping();
    }, {
      scheduled: true,
      timezone: 'Europe/Rome'
    });

    logger.info('Hourly ping scheduled (every hour at minute 0)');
  }

  /**
   * Stop all scheduled jobs
   */
  stopAll() {
    if (this.dailyCheckJob) {
      this.dailyCheckJob.stop();
      this.dailyCheckJob = null;
      logger.info('Daily check job stopped');
    }

    if (this.hourlyPingJob) {
      this.hourlyPingJob.stop();
      this.hourlyPingJob = null;
      logger.info('Hourly ping job stopped');
    }
  }

  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
const operationalControl = new OperationalControlService();
module.exports = operationalControl;
