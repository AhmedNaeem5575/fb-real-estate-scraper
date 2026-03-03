const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');

const dbPath = process.env.DB_PATH || './data/database.sqlite';
const db = new Database(path.resolve(dbPath));

// Enable foreign keys
db.pragma('foreign_keys = ON');

function initialize() {
  logger.info('Initializing database...');

  // Create groups table (mirrors external API structure)
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id INTEGER,
      facebook_group_id TEXT UNIQUE,
      url TEXT,
      name TEXT,
      is_active INTEGER DEFAULT 1,
      polling_interval_min INTEGER DEFAULT 60,
      last_scraped TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Create listings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      post_id TEXT NOT NULL,
      listing_type TEXT,
      property_type TEXT,
      title TEXT,
      price TEXT,
      location TEXT,
      owner_name TEXT,
      owner_profile_url TEXT,
      contact_info TEXT,
      email TEXT,
      post_url TEXT,
      raw_content TEXT,
      external_post_id INTEGER,
      external_contact_id INTEGER,
      external_lead_id INTEGER,
      request_payload TEXT,
      response_payload TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      scraped_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
      UNIQUE(group_id, post_id)
    )
  `);

  // Add new columns to listings table if they don't exist (for existing databases)
  const listingsColumnsToAdd = [
    'owner_profile_url TEXT',
    'property_type TEXT',
    'email TEXT',
    'external_post_id INTEGER',
    'external_contact_id INTEGER',
    'external_lead_id INTEGER',
    'request_payload TEXT',
    'response_payload TEXT',
    'status TEXT DEFAULT "pending"',
    'error_message TEXT'
  ];

  for (const col of listingsColumnsToAdd) {
    try {
      db.exec(`ALTER TABLE listings ADD COLUMN ${col}`);
    } catch (e) {
      // Column already exists, ignore
    }
  }

  // Add new columns to groups table if they don't exist
  const groupsColumnsToAdd = [
    'external_id INTEGER',
    'facebook_group_id TEXT',
    'polling_interval_min INTEGER DEFAULT 60',
    'endpoint TEXT'
  ];

  for (const col of groupsColumnsToAdd) {
    try {
      db.exec(`ALTER TABLE groups ADD COLUMN ${col}`);
    } catch (e) {
      // Column already exists, ignore
    }
  }

  // Create indexes for better query performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_listings_group_id ON listings(group_id);
    CREATE INDEX IF NOT EXISTS idx_listings_listing_type ON listings(listing_type);
    CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
    CREATE INDEX IF NOT EXISTS idx_groups_is_active ON groups(is_active);
  `);

  // Create comments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER,
      post_id TEXT NOT NULL,
      post_url TEXT,
      comment_id TEXT,
      author_name TEXT,
      author_profile_url TEXT,
      content TEXT,
      external_contact_id INTEGER,
      external_lead_id INTEGER,
      request_payload TEXT,
      response_payload TEXT,
      status TEXT DEFAULT 'pending',
      error_message TEXT,
      scraped_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
      UNIQUE(post_id, comment_id)
    )
  `);

  // Add post_url column to comments if it doesn't exist
  try {
    db.exec(`ALTER TABLE comments ADD COLUMN post_url TEXT`);
  } catch (e) {
    // Column already exists, ignore
  }

  // Add indexes for comments
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
    CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
  `);

  // Create admins table
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Create operational_state table for bot operational control
  db.exec(`
    CREATE TABLE IF NOT EXISTS operational_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      can_operate INTEGER DEFAULT 0,
      manual_blocked INTEGER DEFAULT 0,
      daily_enabled INTEGER DEFAULT 0,
      daily_flag_date TEXT,
      reason TEXT,
      last_checked TEXT,
      api_key_valid INTEGER DEFAULT 1,
      cached_can_operate INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Seed default operational state if not exists
  const opStateExists = db.prepare("SELECT id FROM operational_state WHERE id = 1").get();
  if (!opStateExists) {
    db.prepare(`
      INSERT INTO operational_state (id, can_operate, manual_blocked, daily_enabled, api_key_valid, cached_can_operate)
      VALUES (1, 0, 0, 0, 1, 0)
    `).run();
    logger.info('Default operational state seeded');
  }

  // Seed default admin (username: admin, password: admin)
  const adminExists = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get();
  if (!adminExists) {
    const passwordHash = crypto.createHash('sha256').update('admin').digest('hex');
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (@username, @password_hash)').run({
      username: 'admin',
      password_hash: passwordHash
    });
    logger.info('Default admin seeded (username: admin, password: admin)');
  }

  logger.info('Database initialized successfully');
}

module.exports = {
  db,
  initialize
};
