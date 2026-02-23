require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './data/database.sqlite';
const db = new Database(path.resolve(dbPath));

// Disable foreign keys for drop operations
db.pragma('foreign_keys = OFF');

const VALID_TABLES = ['groups', 'listings', 'admins', 'comments'];

function dropTable(tableName) {
  console.log(`Dropping table: ${tableName}...`);

  const indexDrops = {
    groups: ['idx_groups_is_active'],
    listings: ['idx_listings_group_id', 'idx_listings_listing_type', 'idx_listings_status'],
    admins: [],
    comments: ['idx_comments_post_id', 'idx_comments_status']
  };

  // Drop indexes first
  if (indexDrops[tableName]) {
    indexDrops[tableName].forEach(idx => {
      try {
        db.exec(`DROP INDEX IF EXISTS ${idx}`);
      } catch (e) {}
    });
  }

  db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  console.log(`Table ${tableName} dropped`);
}

function dropAllTables() {
  console.log('Dropping all tables...');

  db.exec(`
    DROP TABLE IF EXISTS comments;
    DROP TABLE IF EXISTS listings;
    DROP TABLE IF EXISTS groups;
    DROP TABLE IF EXISTS admins;
    DROP INDEX IF EXISTS idx_listings_group_id;
    DROP INDEX IF EXISTS idx_listings_listing_type;
    DROP INDEX IF EXISTS idx_listings_status;
    DROP INDEX IF EXISTS idx_groups_is_active;
    DROP INDEX IF EXISTS idx_comments_post_id;
    DROP INDEX IF EXISTS idx_comments_status;
  `);

  console.log('All tables dropped');
}

function createGroupsTable() {
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_groups_is_active ON groups(is_active)`);
}

function createListingsTable() {
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
      external_id INTEGER,
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
  db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_group_id ON listings(group_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_listing_type ON listings(listing_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status)`);
}

function createAdminsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function createCommentsTable() {
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
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL,
      UNIQUE(post_id, comment_id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status)`);
}

function createSchema(tables = null) {
  console.log('Creating schema...');

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  if (!tables || tables.includes('groups')) createGroupsTable();
  if (!tables || tables.includes('listings')) createListingsTable();
  if (!tables || tables.includes('admins')) createAdminsTable();
  if (!tables || tables.includes('comments')) createCommentsTable();

  console.log('Schema created successfully');
}

function seedAdmin() {
  const adminExists = db.prepare("SELECT id FROM admins WHERE username = 'admin'").get();
  if (!adminExists) {
    const passwordHash = crypto.createHash('sha256').update('admin').digest('hex');
    db.prepare('INSERT INTO admins (username, password_hash) VALUES (@username, @password_hash)').run({
      username: 'admin',
      password_hash: passwordHash
    });
    console.log('Seeded default admin (username: admin, password: admin)');
  } else {
    console.log('Admin already exists, skipping');
  }
}

function seedGroups() {
  const groups = [
    { url: 'https://www.facebook.com/groups/gentedidonboscocinecitta', name: "NOI GENTE DI DON BOSCO CINECITTA'APPIO CLAUDIO QUADRARO TORRESPACCATA" },
    { url: 'https://www.facebook.com/groups/29065741238', name: "Quartiere Appio-Latino Tuscolano 🇮🇹 L'originale ex Municipio IX" },
    { url: 'https://www.facebook.com/groups/537677973609674', name: 'Quartiere Giulio Agricola - Tuscolana' },
    { url: 'https://www.facebook.com/groups/436299884586329', name: 'Ricette facili per la famiglia' },
    { url: 'https://www.facebook.com/groups/243783935794224', name: 'SEI DE CENTOCELLE SE......' },
    { url: 'https://www.facebook.com/groups/253457421502772', name: 'Sei di Cinecittà Est se...' }
  ];

  const insertGroup = db.prepare('INSERT INTO groups (url, name, is_active) VALUES (@url, @name, 1)');
  groups.forEach(group => {
    insertGroup.run({ url: group.url, name: group.name });
  });
  console.log(`Seeded ${groups.length} Facebook groups`);
}

function run(options = {}) {
  const { reseed = false, table = null } = options;

  if (reseed) {
    if (table) {
      if (!VALID_TABLES.includes(table)) {
        console.error(`Invalid table: ${table}. Valid tables: ${VALID_TABLES.join(', ')}`);
        process.exit(1);
      }
      console.log(`Reseeding table: ${table}...`);
      dropTable(table);
      createSchema([table]);
    } else {
      console.log('Reseeding all tables...');
      dropAllTables();
      createSchema();
    }
  } else {
    console.log('Running seed...');
    createSchema();
  }

  // Seed based on what needs seeding
  if (!table || table === 'admins') seedAdmin();
  if (!table || table === 'groups') seedGroups();

  console.log('Done!');
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);
  const reseed = args.includes('--reseed') || args.includes('-r');

  // Find table argument (non-flag argument after --reseed/-r)
  let table = null;
  const flagArgs = ['--reseed', '-r'];
  args.forEach((arg, i) => {
    if (!flagArgs.includes(arg) && !arg.startsWith('-')) {
      table = arg;
    }
  });

  run({ reseed, table });
}

module.exports = { dropTable, dropAllTables, createSchema, seedAdmin, seedGroups, run };
