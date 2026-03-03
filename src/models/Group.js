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

  findByUrl(url) {
    return db.prepare('SELECT * FROM groups WHERE url = ?').get(url);
  },

  /**
   * Find group by facebook_group_id OR url
   * @param {Object} params - Search parameters
   * @param {string} params.facebook_group_id - Facebook group ID
   * @param {string} params.url - Group URL
   * @returns {Object|null} Group record or null
   */
  findByFacebookIdOrUrl(params) {
    const { facebook_group_id, url } = params;

    // Try by facebook_group_id first
    if (facebook_group_id) {
      const group = this.findByFacebookGroupId(facebook_group_id);
      if (group) return group;
    }

    // Fall back to URL
    if (url) {
      return this.findByUrl(url);
    }

    return null;
  },

  findActive() {
    return db.prepare('SELECT * FROM groups WHERE is_active = 1').all();
  },

  create(data) {
    const stmt = db.prepare(`
      INSERT INTO groups (external_id, facebook_group_id, url, name, is_active, polling_interval_min, endpoint)
      VALUES (@external_id, @facebook_group_id, @url, @name, @is_active, @polling_interval_min, @endpoint)
    `);

    const result = stmt.run({
      external_id: data.external_id || null,
      facebook_group_id: data.facebook_group_id || null,
      url: data.url || null,
      name: data.name || null,
      is_active: data.is_active !== undefined ? data.is_active : 1,
      polling_interval_min: data.polling_interval_min || 60,
      endpoint: data.endpoint || null
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
          polling_interval_min = COALESCE(@polling_interval_min, polling_interval_min),
          endpoint = COALESCE(@endpoint, endpoint)
        WHERE id = @id
      `);

      stmt.run({
        id: existing.id,
        external_id: data.external_id || existing.external_id,
        name: data.name || existing.name,
        is_active: data.is_active !== undefined ? data.is_active : existing.is_active,
        polling_interval_min: data.polling_interval_min || existing.polling_interval_min,
        endpoint: data.endpoint || existing.endpoint
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
    if (data.endpoint !== undefined) {
      fields.push('endpoint = @endpoint');
      values.endpoint = data.endpoint;
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
  },

  /**
   * Sync groups from CRM data
   * @param {Array} crmGroups - Array of group objects from CRM
   * @returns {Object} Sync results { added, updated }
   */
  syncFromCrm(crmGroups) {
    const results = { added: 0, updated: 0 };

    if (!Array.isArray(crmGroups)) {
      logger.error('syncFromCrm: crmGroups must be an array');
      return results;
    }

    for (const crmGroup of crmGroups) {
      try {
        // Check by facebook_group_id OR url
        const existing = this.findByFacebookIdOrUrl({
          facebook_group_id: crmGroup.facebook_group_id,
          url: crmGroup.url
        });

        if (existing) {
          // Update existing group
          this.update(existing.id, {
            external_id: crmGroup.id,
            facebook_group_id: crmGroup.facebook_group_id || existing.facebook_group_id,
            url: crmGroup.facebook_url || crmGroup.url || existing.url,
            name: crmGroup.name || existing.name,
            is_active: crmGroup.is_active !== undefined ? (crmGroup.is_active ? 1 : 0) : existing.is_active,
            polling_interval_min: crmGroup.polling_interval_min || existing.polling_interval_min,
            endpoint: crmGroup.endpoint || existing.endpoint
          });
          results.updated++;
        } else {
          // Create new group
          this.create({
            external_id: crmGroup.id,
            facebook_group_id: crmGroup.facebook_group_id,
            url: crmGroup.facebook_url || crmGroup.url || (crmGroup.facebook_group_id ? `https://www.facebook.com/groups/${crmGroup.facebook_group_id}` : null),
            name: crmGroup.name,
            is_active: crmGroup.is_active !== undefined ? (crmGroup.is_active ? 1 : 0) : 1,
            polling_interval_min: crmGroup.polling_interval_min || 60,
            endpoint: crmGroup.endpoint || null
          });
          results.added++;
        }
      } catch (err) {
        const identifier = crmGroup.facebook_group_id || crmGroup.url || 'unknown';
        logger.error(`Error syncing CRM group ${identifier}: ${err.message}`);
      }
    }

    logger.info(`syncFromCrm: ${results.added} added, ${results.updated} updated`);
    return results;
  },

  /**
   * Mark a group as inactive by Facebook group ID or URL
   * @param {string} identifier - Facebook group ID or URL
   * @param {string} reason - Reason for deactivation
   */
  markInactiveByFacebookId(identifier, reason) {
    // Try to find by facebook_group_id first
    let group = this.findByFacebookGroupId(identifier);

    // If not found, try by URL
    if (!group && identifier?.includes('facebook.com')) {
      group = this.findByUrl(identifier);
    }

    if (!group) {
      logger.warn(`Cannot mark inactive: group ${identifier} not found`);
      return null;
    }

    logger.info(`Marking group ${identifier} as inactive. Reason: ${reason}`);
    return this.update(group.id, {
      is_active: 0
    });
  }
};

module.exports = Group;
