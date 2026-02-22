const { db } = require('../config/database');
const crypto = require('crypto');

const Admin = {
  findByUsername(username) {
    return db.prepare('SELECT * FROM admins WHERE username = ?').get(username);
  },

  findById(id) {
    return db.prepare('SELECT id, username, created_at FROM admins WHERE id = ?').get(id);
  },

  verifyPassword(admin, password) {
    if (!admin) return false;
    const hash = crypto.createHash('sha256').update(password).digest('hex');
    return admin.password_hash === hash;
  },

  create(data) {
    const passwordHash = crypto.createHash('sha256').update(data.password).digest('hex');
    const result = db.prepare('INSERT INTO admins (username, password_hash) VALUES (@username, @password_hash)').run({
      username: data.username,
      password_hash: passwordHash
    });
    return this.findById(result.lastInsertRowid);
  },

  delete(id) {
    const admin = this.findById(id);
    if (!admin) return null;
    db.prepare('DELETE FROM admins WHERE id = ?').run(id);
    return admin;
  }
};

module.exports = Admin;
