const express = require('express');
const router = express.Router();

const groupsRouter = require('./groups');
const listingsRouter = require('./listings');
const authRouter = require('./auth');

router.use('/auth', authRouter);
router.use('/groups', groupsRouter);
router.use('/listings', listingsRouter);

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

module.exports = router;
