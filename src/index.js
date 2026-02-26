require('dotenv').config();

const path = require('path');
const express = require('express');
const routes = require('./routes');
const scheduler = require('./services/scheduler');
const scraper = require('./services/scraper');
const operationalControl = require('./services/operationalControl');
const groupSync = require('./services/groupSync');
const logger = require('./utils/logger');
const { getSession } = require('./middleware/auth');
const { initialize } = require('./config/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple cookie parser middleware
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      if (name && value) {
        req.cookies[name] = decodeURIComponent(value);
      }
    });
  }
  next();
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve web UI (login.html is public, index.html protected via JS)
app.use(express.static(path.join(__dirname, '../public')));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Auth middleware for API routes (except /api/auth/*)
app.use('/api', (req, res, next) => {
  // Skip auth for /auth/* routes
  if (req.path.startsWith('/auth')) {
    return next();
  }
  // Skip auth for health check
  if (req.path === '/health') {
    return next();
  }

  const sessionId = req.cookies?.['session_id'];
  const session = getSession(sessionId);

  if (!session) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  req.userId = session.userId;
  next();
});

// Mount webhook routes (no /api prefix, uses its own Bearer token auth)
app.use('/webhook', require('./routes/webhook'));

// API routes
app.use('/api', routes);

// Manual scrape trigger endpoint
app.post('/api/scrape', async (req, res) => {
  try {
    const status = scheduler.getStatus();
    if (status.isRunning) {
      return res.status(409).json({ success: false, error: 'Scrape already in progress' });
    }

    // Run scrape in background
    scheduler.runNow().catch(err => logger.error('Background scrape error:', err.message));
    res.json({ success: true, message: 'Scrape job started in background' });
  } catch (error) {
    logger.error('Error triggering scrape:', error.message);
    res.status(500).json({ success: false, error: 'Failed to start scrape job' });
  }
});

// Scrape status endpoint
app.get('/api/scrape/status', (req, res) => {
  try {
    const status = scheduler.getStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    logger.error('Error getting scrape status:', error.message);
    res.status(500).json({ success: false, error: 'Failed to get scrape status' });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error:', err.message);
  res.status(500).json({ success: false, error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  operationalControl.stopAll();
  scheduler.stop();
  await scraper.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received. Shutting down gracefully...');
  operationalControl.stopAll();
  scheduler.stop();
  await scraper.close();
  process.exit(0);
});

// Start server
async function start() {
  try {
    await initialize();

    // Initialize operational control service
    await operationalControl.initialize();
    operationalControl.setDependencies(scraper, scheduler);

    // Start daily check at 01:00 and hourly ping
    operationalControl.startDailyCheck();
    operationalControl.startHourlyPing();

    // Initial group sync from CRM
    await groupSync.refreshGroups();

    // Start scheduler
    scheduler.start();

    // Start HTTP server
    app.listen(PORT, () => {
      logger.info(`Server running on http://localhost:${PORT}`);
      logger.info('Web UI available at http://localhost:${PORT}');
      logger.info('Default login: admin / admin');
      logger.info('API endpoints:');
      logger.info('  POST   /api/auth/login  - Login');
      logger.info('  POST   /api/auth/logout - Logout');
      logger.info('  GET    /api/auth/me     - Current user');
      logger.info('  GET    /api/groups      - List all groups');
      logger.info('  GET    /api/listings    - List all listings');
      logger.info('  POST   /api/scrape      - Trigger manual scrape');
      logger.info('Webhook endpoints:');
      logger.info('  POST   /webhook/status  - Receive status updates from CRM');
      logger.info('  GET    /webhook/health  - Webhook health check');
    });
  } catch (error) {
    logger.error('Failed to start server:', error.message);
    process.exit(1);
  }
}

start();
