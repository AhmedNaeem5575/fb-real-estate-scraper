const { db } = require('../config/database');
const externalApi = require('../services/externalApi');
const logger = require('../utils/logger');

const Listing = {
  findAll(options = {}) {
    let query = 'SELECT l.*, g.name as group_name, g.url as group_url, g.facebook_group_id FROM listings l LEFT JOIN groups g ON l.group_id = g.id';
    const conditions = [];
    const params = {};

    if (options.listing_type) {
      conditions.push('l.listing_type = @listing_type');
      params.listing_type = options.listing_type;
    }

    if (options.status) {
      conditions.push('l.status = @status');
      params.status = options.status;
    }

    if (options.group_id) {
      conditions.push('l.group_id = @group_id');
      params.group_id = options.group_id;
    }

    if (options.search) {
      conditions.push('(l.title LIKE @search OR l.location LIKE @search OR l.owner_name LIKE @search OR l.raw_content LIKE @search)');
      params.search = `%${options.search}%`;
    }

    if (options.date_from) {
      conditions.push('l.scraped_at >= @date_from');
      params.date_from = options.date_from;
    }

    if (options.date_to) {
      conditions.push('l.scraped_at <= @date_to');
      params.date_to = options.date_to + ' 23:59:59';
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY l.scraped_at DESC';

    if (options.limit) {
      query += ' LIMIT @limit';
      params.limit = options.limit;
    }

    if (options.offset) {
      query += ' OFFSET @offset';
      params.offset = options.offset;
    }

    return db.prepare(query).all(params);
  },

  findById(id) {
    return db.prepare(`
      SELECT l.*, g.name as group_name, g.url as group_url, g.facebook_group_id
      FROM listings l
      LEFT JOIN groups g ON l.group_id = g.id
      WHERE l.id = ?
    `).get(id);
  },

  findByGroupId(groupId) {
    return db.prepare(`
      SELECT * FROM listings WHERE group_id = ? ORDER BY scraped_at DESC
    `).all(groupId);
  },

  findByPostId(groupId, postId) {
    return db.prepare(`
      SELECT * FROM listings WHERE group_id = ? AND post_id = ?
    `).get(groupId, postId);
  },

  findByPostIdOnly(postId) {
    return db.prepare(`
      SELECT * FROM listings WHERE post_id = ?
    `).get(postId);
  },

  findByExternalId(externalId) {
    return db.prepare(`
      SELECT * FROM listings WHERE external_id = ?
    `).get(externalId);
  },

  findPending() {
    return db.prepare(`
      SELECT * FROM listings WHERE status = 'pending' ORDER BY scraped_at ASC
    `).all();
  },

  create(data) {
    const stmt = db.prepare(`
      INSERT INTO listings (
        group_id, post_id, listing_type, property_type, title, price,
        location, owner_name, owner_profile_url, contact_info, email,
        post_url, raw_content, status
      ) VALUES (
        @group_id, @post_id, @listing_type, @property_type, @title, @price,
        @location, @owner_name, @owner_profile_url, @contact_info, @email,
        @post_url, @raw_content, @status
      )
    `);

    const result = stmt.run({
      group_id: data.group_id,
      post_id: data.post_id,
      listing_type: data.listing_type || null,
      property_type: data.property_type || null,
      title: data.title || null,
      price: data.price || null,
      location: data.location || null,
      owner_name: data.owner_name || null,
      owner_profile_url: data.owner_profile_url || null,
      contact_info: data.contact_info || null,
      email: data.email || null,
      post_url: data.post_url || null,
      raw_content: data.raw_content || null,
      status: data.status || 'pending'
    });

    return this.findById(result.lastInsertRowid);
  },

  upsert(data) {
    // Check if listing already exists
    const existing = this.findByPostId(data.group_id, data.post_id);

    if (existing) {
      // Update existing listing
      const stmt = db.prepare(`
        UPDATE listings SET
          listing_type = COALESCE(@listing_type, listing_type),
          property_type = COALESCE(@property_type, property_type),
          title = COALESCE(@title, title),
          price = COALESCE(@price, price),
          location = COALESCE(@location, location),
          owner_name = COALESCE(@owner_name, owner_name),
          owner_profile_url = COALESCE(@owner_profile_url, owner_profile_url),
          contact_info = COALESCE(@contact_info, contact_info),
          email = COALESCE(@email, email),
          post_url = COALESCE(@post_url, post_url),
          raw_content = COALESCE(@raw_content, raw_content),
          scraped_at = datetime('now')
        WHERE id = @id
      `);

      stmt.run({
        id: existing.id,
        listing_type: data.listing_type || null,
        property_type: data.property_type || null,
        title: data.title || null,
        price: data.price || null,
        location: data.location || null,
        owner_name: data.owner_name || null,
        owner_profile_url: data.owner_profile_url || null,
        contact_info: data.contact_info || null,
        email: data.email || null,
        post_url: data.post_url || null,
        raw_content: data.raw_content || null
      });

      return this.findById(existing.id);
    }

    return this.create(data);
  },

  /**
   * Update listing with API response data
   */
  updateApiResponse(id, data) {
    const stmt = db.prepare(`
      UPDATE listings SET
        external_post_id = @external_post_id,
        external_contact_id = @external_contact_id,
        external_lead_id = @external_lead_id,
        request_payload = @request_payload,
        response_payload = @response_payload,
        status = @status,
        error_message = @error_message
      WHERE id = @id
    `);

    stmt.run({
      id,
      external_post_id: data.external_post_id || null,
      external_contact_id: data.external_contact_id || null,
      external_lead_id: data.external_lead_id || null,
      request_payload: data.request_payload ? JSON.stringify(data.request_payload) : null,
      response_payload: data.response_payload ? JSON.stringify(data.response_payload) : null,
      status: data.status || 'sent',
      error_message: data.error_message || null
    });

    return this.findById(id);
  },

  /**
   * Mark listing as sent to external API
   */
  markAsSent(id, externalIds, requestPayload, responsePayload) {
    return this.updateApiResponse(id, {
      external_post_id: externalIds?.post_id,
      external_contact_id: externalIds?.contact_id,
      external_lead_id: externalIds?.lead_id,
      request_payload: requestPayload,
      response_payload: responsePayload,
      status: 'sent'
    });
  },

  /**
   * Mark listing as failed
   */
  markAsFailed(id, requestPayload, responsePayload, errorMessage) {
    return this.updateApiResponse(id, {
      request_payload: requestPayload,
      response_payload: responsePayload,
      status: 'failed',
      error_message: errorMessage
    });
  },

  delete(id) {
    const listing = this.findById(id);
    if (!listing) return null;

    db.prepare('DELETE FROM listings WHERE id = ?').run(id);
    return listing;
  },

  deleteByGroupId(groupId) {
    const result = db.prepare('DELETE FROM listings WHERE group_id = ?').run(groupId);
    return result.changes;
  },

  count(options = {}) {
    // Backward-compat: allow count(groupId) calls with a plain number
    if (typeof options === 'number') options = { group_id: options };

    let query = 'SELECT COUNT(*) as count FROM listings l';
    const conditions = [];
    const params = {};

    if (options.group_id) {
      conditions.push('l.group_id = @group_id');
      params.group_id = options.group_id;
    }

    if (options.listing_type) {
      conditions.push('l.listing_type = @listing_type');
      params.listing_type = options.listing_type;
    }

    if (options.status) {
      conditions.push('l.status = @status');
      params.status = options.status;
    }

    if (options.search) {
      conditions.push('(l.title LIKE @search OR l.location LIKE @search OR l.owner_name LIKE @search OR l.raw_content LIKE @search)');
      params.search = `%${options.search}%`;
    }

    if (options.date_from) {
      conditions.push('l.scraped_at >= @date_from');
      params.date_from = options.date_from;
    }

    if (options.date_to) {
      conditions.push('l.scraped_at <= @date_to');
      params.date_to = options.date_to + ' 23:59:59';
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    return db.prepare(query).get(params).count;
  },

  /**
   * Send a listing to external API
   */
  async sendToExternalApi(listingId) {
    const listing = this.findById(listingId);
    if (!listing) {
      logger.error(`Listing ${listingId} not found`);
      return { success: false, error: 'Listing not found' };
    }

    // Get the group
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(listing.group_id);
    if (!group) {
      logger.error(`Group ${listing.group_id} not found for listing ${listingId}`);
      return { success: false, error: 'Group not found' };
    }

    try {
      logger.info(`Sending listing ${listingId} to external API...`);

      const result = await externalApi.ingestPost(listing, group);

      if (result.success) {
        // Extract external IDs from response
        const externalIds = result.externalIds || {};

        this.markAsSent(listingId, externalIds, result.requestPayload, result.responsePayload);
        logger.info(`Listing ${listingId} sent successfully. Post: ${externalIds.post_id}, Contact: ${externalIds.contact_id}, Lead: ${externalIds.lead_id}`);
        return { success: true, externalIds, data: result.data };
      } else {
        this.markAsFailed(listingId, result.requestPayload, result.responsePayload, JSON.stringify(result.error));
        logger.error(`Failed to send listing ${listingId}:`, result.error);
        return { success: false, error: result.error };
      }
    } catch (error) {
      this.markAsFailed(listingId, null, null, error.message);
      logger.error(`Error sending listing ${listingId}:`, error.message);
      return { success: false, error: error.message };
    }
  },

  /**
   * Send all pending listings to external API
   */
  async sendAllPending() {
    const pending = this.findPending();
    logger.info(`Found ${pending.length} pending listings to send`);

    const results = {
      total: pending.length,
      success: 0,
      failed: 0,
      errors: []
    };

    for (const listing of pending) {
      const result = await this.sendToExternalApi(listing.id);

      if (result.success) {
        results.success++;
      } else {
        results.failed++;
        results.errors.push({
          listing_id: listing.id,
          error: result.error
        });
      }

      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    logger.info(`Sent ${results.success}/${results.total} listings (${results.failed} failed)`);
    return results;
  }
};

module.exports = Listing;
