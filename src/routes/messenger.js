const express = require('express');
const router = express.Router();
const scraper = require('../services/scraper');
const messengerService = require('../services/messenger');
const logger = require('../utils/logger');

router.post('/send', async (req, res) => {
  try {
    const { user_name, message } = req.body;

    if (!user_name || !user_name.trim()) {
      return res.status(400).json({ success: false, error: 'user_name is required' });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'message is required' });
    }

    // Ensure browser context is initialized and usable
    let context = scraper.getContext();

    if (!context) {
      await scraper.initialize();
      context = scraper.getContext();
    }

    try {
      // Test if context is still alive by creating a page
      const testPage = await context.newPage();
      await testPage.close();
    } catch (_) {
      logger.info('Browser context was closed, re-initializing...');
      await scraper.initialize();
      context = scraper.getContext();
    }

    if (!context) {
      return res.status(503).json({ success: false, error: 'Browser session not available' });
    }

    const result = await messengerService.sendMessage(context, user_name.trim(), message.trim());

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('Error sending message:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
