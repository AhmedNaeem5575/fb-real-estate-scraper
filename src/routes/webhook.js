const express = require('express');
const router = express.Router();
const webhookAuth = require('../middleware/webhookAuth');
const operationalControl = require('../services/operationalControl');
const logger = require('../utils/logger');

// Valid webhook event types
const VALID_EVENTS = [
  'midnight_credits_ok',
  'midnight_no_credits',
  'manual_block',
  'manual_unblock',
  'manual_unblock_no_credits',
  'evening_credits_available'
];

/**
 * POST /webhook/status
 * Receive operational status updates from CRM
 *
 * Expected body:
 * {
 *   "event": "midnight_credits_ok" | "midnight_no_credits" | "manual_block" | ...,
 *   "can_operate": boolean,
 *   "reason": string (optional)
 * }
 */
router.post('/status', webhookAuth, (req, res) => {
  try {
    const { event, can_operate, reason } = req.body;

    // Validate event type
    if (!event) {
      logger.warn('Webhook received without event type');
      return res.status(400).json({
        success: false,
        error: 'Missing required field: event'
      });
    }

    if (!VALID_EVENTS.includes(event)) {
      logger.warn(`Webhook received unknown event type: ${event}`);
      return res.status(400).json({
        success: false,
        error: `Unknown event type: ${event}`
      });
    }

    logger.info(`Webhook received: event=${event}, can_operate=${can_operate}, reason=${reason || 'none'}`);

    // Handle the event through operationalControl
    const result = operationalControl.handleWebhookEvent(event, {
      can_operate,
      reason
    });

    res.status(200).json({
      success: true,
      received: true,
      event,
      handled: result.handled
    });

  } catch (error) {
    logger.error('Webhook processing error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Internal server error processing webhook'
    });
  }
});

/**
 * GET /webhook/health
 * Health check endpoint for webhook route (no auth required)
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint is healthy'
  });
});

module.exports = router;
