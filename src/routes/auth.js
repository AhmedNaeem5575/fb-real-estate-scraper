const express = require('express');
const router = express.Router();
const Admin = require('../models/Admin');
const { createSession, deleteSession, getSession, setSessionCookie, clearSessionCookie } = require('../middleware/auth');
const logger = require('../utils/logger');

// POST /api/auth/login
router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required' });
    }

    const admin = Admin.findByUsername(username);

    if (!admin || !Admin.verifyPassword(admin, password)) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    const sessionId = createSession(admin.id);
    setSessionCookie(res, sessionId);

    logger.info(`Admin logged in: ${username}`);
    res.json({
      success: true,
      data: { id: admin.id, username: admin.username }
    });
  } catch (error) {
    logger.error('Login error:', error.message);
    res.status(500).json({ success: false, error: 'Login failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  try {
    const sessionId = req.cookies?.['session_id'];
    if (sessionId) {
      deleteSession(sessionId);
    }
    clearSessionCookie(res);
    res.json({ success: true, message: 'Logged out' });
  } catch (error) {
    logger.error('Logout error:', error.message);
    res.status(500).json({ success: false, error: 'Logout failed' });
  }
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  try {
    const sessionId = req.cookies?.['session_id'];
    const session = getSession(sessionId);

    if (!session) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }

    const admin = Admin.findById(session.userId);
    if (!admin) {
      clearSessionCookie(res);
      return res.status(401).json({ success: false, error: 'User not found' });
    }

    res.json({ success: true, data: admin });
  } catch (error) {
    logger.error('Auth check error:', error.message);
    res.status(500).json({ success: false, error: 'Auth check failed' });
  }
});

module.exports = router;
