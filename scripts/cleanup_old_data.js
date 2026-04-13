require('dotenv').config();

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || './data/database.sqlite';
const db = new Database(path.resolve(dbPath));

db.pragma('foreign_keys = ON');

function cleanup(daysOld = 3, options = {}) {
  const { dryRun = false } = options;

  const cutoffDate = `datetime('now', '-${daysOld} days')`;

  // Count records to delete
  const oldComments = db.prepare(
    `SELECT COUNT(*) as count FROM comments WHERE created_at < ${cutoffDate}`
  ).get().count;

  const oldListings = db.prepare(
    `SELECT COUNT(*) as count FROM listings WHERE created_at < ${cutoffDate}`
  ).get().count;

  console.log(`Records older than ${daysOld} day(s):`);
  console.log(`  Comments: ${oldComments}`);
  console.log(`  Listings: ${oldListings}`);

  if (oldComments === 0 && oldListings === 0) {
    console.log('No records to delete.');
    return { comments: 0, listings: 0 };
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No records were deleted. Remove --dry-run to actually delete.');
    return { comments: oldComments, listings: oldListings, dryRun: true };
  }

  // Delete comments first (child records), then listings (parent records)
  const deletedComments = db.prepare(
    `DELETE FROM comments WHERE created_at < ${cutoffDate}`
  ).run().changes;

  const deletedListings = db.prepare(
    `DELETE FROM listings WHERE created_at < ${cutoffDate}`
  ).run().changes;

  console.log(`\nDeleted:`);
  console.log(`  Comments: ${deletedComments}`);
  console.log(`  Listings: ${deletedListings}`);

  return { comments: deletedComments, listings: deletedListings };
}

// Run if called directly
if (require.main === module) {
  const args = process.argv.slice(2);

  const dryRun = args.includes('--dry-run');

  let daysOld = 3;
  const daysArg = args.find(a => a.startsWith('--days='));
  if (daysArg) {
    daysOld = parseInt(daysArg.split('=')[1], 10);
    if (isNaN(daysOld) || daysOld < 1) {
      console.error('Invalid --days value. Must be a positive integer.');
      process.exit(1);
    }
  }

  console.log(`Cleaning up data older than ${daysOld} day(s)...`);
  cleanup(daysOld, { dryRun });
}

module.exports = { cleanup };
