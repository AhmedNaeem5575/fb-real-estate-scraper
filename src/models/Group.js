const { db } = require('../config/database');
const externalApi = require('../services/externalApi');
const logger = require('../utils/logger');

const Group = {
  findAll() {
    return db.prepare('SELECT * FROM groups ORDER BY created_at DESC').all();
  },

  findById(id) {
    return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  },

  findByFacebookGroupId(facebookGroupId) {
    return db.prepare('SELECT * FROM groups WHERE facebook_group_id = ?').get(facebookGroupId);
  },

  findActive() {
    return db.prepare('SELECT * FROM groups WHERE is_active = 1').all();
  },

  create(data) {
    const stmt = db.prepare(`
      INSERT INTO groups (external_id, facebook_group_id, url, name, is_active, polling_interval_min)
      VALUES (@external_id, @facebook_group_id, @url, @name, @is_active, @polling_interval_min)
    `);

    const result = stmt.run({
      external_id: data.external_id || null,
      facebook_group_id: data.facebook_group_id || null,
      url: data.url || null,
      name: data.name || null,
      is_active: data.is_active !== undefined ? data.is_active : 1,
      polling_interval_min: data.polling_interval_min || 60
    });

    return this.findById(result.lastInsertRowid);
  },

  upsert(data) {
    // Check if group already exists by facebook_group_id
    let existing = null;
    if (data.facebook_group_id) {
      existing = this.findByFacebookGroupId(data.facebook_group_id);
    } else if (data.url) {
      existing = db.prepare('SELECT * FROM groups WHERE url = ?').get(data.url);
    }

    if (existing) {
      // Update existing group
      const stmt = db.prepare(`
        UPDATE groups SET
          external_id = @external_id,
          name = COALESCE(@name, name),
          is_active = COALESCE(@is_active, is_active),
          polling_interval_min = COALESCE(@polling_interval_min, polling_interval_min)
        WHERE id = @id
      `);

      stmt.run({
        id: existing.id,
        external_id: data.external_id || existing.external_id,
        name: data.name || existing.name,
        is_active: data.is_active !== undefined ? data.is_active : existing.is_active,
        polling_interval_min: data.polling_interval_min || existing.polling_interval_min
      });

      return this.findById(existing.id);
    }

    return this.create(data);
  },

  update(id, data) {
    const fields = [];
    const values = { id };

    if (data.external_id !== undefined) {
      fields.push('external_id = @external_id');
      values.external_id = data.external_id;
    }
    if (data.facebook_group_id !== undefined) {
      fields.push('facebook_group_id = @facebook_group_id');
      values.facebook_group_id = data.facebook_group_id;
    }
    if (data.url !== undefined) {
      fields.push('url = @url');
      values.url = data.url;
    }
    if (data.name !== undefined) {
      fields.push('name = @name');
      values.name = data.name;
    }
    if (data.is_active !== undefined) {
      fields.push('is_active = @is_active');
      values.is_active = data.is_active;
    }
    if (data.polling_interval_min !== undefined) {
      fields.push('polling_interval_min = @polling_interval_min');
      values.polling_interval_min = data.polling_interval_min;
    }
    if (data.last_scraped !== undefined) {
      fields.push('last_scraped = @last_scraped');
      values.last_scraped = data.last_scraped;
    }

    if (fields.length === 0) return this.findById(id);

    const stmt = db.prepare(`
      UPDATE groups SET ${fields.join(', ')} WHERE id = @id
    `);

    stmt.run(values);
    return this.findById(id);
  },

  updateLastScraped(id) {
    const stmt = db.prepare(`
      UPDATE groups SET last_scraped = datetime('now') WHERE id = ?
    `);
    stmt.run(id);
    return this.findById(id);
  },

  delete(id) {
    const group = this.findById(id);
    if (!group) return null;

    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    return group;
  },

  /**
   * Sync groups from external API
   * Since the API doesn't have a GET groups endpoint,
   * we maintain groups locally and sync them when scraping
   */
  async syncFromApi() {
    try {
      logger.info('Syncing groups from external API...');

      const groups = await externalApi.getGroups();

      for (const groupData of groups) {
        this.upsert({
          facebook_group_id: groupData.facebook_group_id,
          name: groupData.name,
          is_active: groupData.is_active ? 1 : 0,
          polling_interval_min: groupData.polling_interval_min
        });
      }

      logger.info(`Synced ${groups.length} groups from API`);
      return groups;
    } catch (error) {
      logger.error('Error syncing groups from API:', error.message);
      return [];
    }
  }
};

module.exports = Group;
