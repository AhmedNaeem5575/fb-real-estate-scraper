const crypto = require('crypto');

// In-memory session store (resets on server restart)
const sessions = new Map();
const SESSION_COOKIE_NAME = 'session_id';
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function createSession(userId) {
  const sessionId = generateSessionId();
  sessions.set(sessionId, {
    userId,
    createdAt: Date.now()
  });
  return sessionId;
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_DURATION_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

function requireAuth(req, res, next) {
  const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
  const session = getSession(sessionId);

  if (!session) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  req.userId = session.userId;
  next();
}

function setSessionCookie(res, sessionId) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    maxAge: SESSION_DURATION_MS,
    sameSite: 'strict'
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME);
}

module.exports = {
  createSession,
  getSession,
  deleteSession,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE_NAME
};
