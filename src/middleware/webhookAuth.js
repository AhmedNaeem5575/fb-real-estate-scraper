const logger = require('../utils/logger');

const WEBHOOK_API_KEY = process.env.FACEBOOK_BOT_WEBHOOK_API_KEY;

/**
 * Middleware to validate Bearer token for webhook endpoints
 * Expects Authorization: Bearer <FACEBOOK_BOT_WEBHOOK_API_KEY>
 */
function webhookAuth(req, res, next) {
  // Check if webhook API key is configured
  if (!WEBHOOK_API_KEY) {
    logger.error('FACEBOOK_BOT_WEBHOOK_API_KEY not configured in environment');
    return res.status(500).json({
      success: false,
      error: 'Webhook authentication not configured'
    });
  }

  // Get authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    logger.warn('Webhook request missing Authorization header');
    return res.status(401).json({
      success: false,
      error: 'Authorization header required'
    });
  }

  // Parse Bearer token
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    logger.warn('Webhook request has invalid Authorization format');
    return res.status(401).json({
      success: false,
      error: 'Invalid authorization format. Expected: Bearer <token>'
    });
  }

  const token = parts[1];

  // Validate token
  if (token !== WEBHOOK_API_KEY) {
    logger.warn('Webhook request has invalid API key');
    return res.status(401).json({
      success: false,
      error: 'Invalid API key'
    });
  }

  // Token is valid, proceed
  next();
}

module.exports = webhookAuth;
