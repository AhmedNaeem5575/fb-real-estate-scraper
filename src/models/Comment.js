const { db } = require('../config/database');
const externalApi = require('../services/externalApi');
const logger = require('../utils/logger');

const Comment = {
  findAll(options = {}) {
    let query = 'SELECT c.*, l.title as listing_title, l.post_url FROM comments c LEFT JOIN listings l ON c.listing_id = l.id';
    const conditions = [];
    const params = {};

    if (options.status) {
      conditions.push('c.status = @status');
      params.status = options.status;
    }

    if (options.post_id) {
      conditions.push('c.post_id = @post_id');
      params.post_id = options.post_id;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY c.scraped_at DESC';

    if (options.limit) {
      query += ' LIMIT @limit';
      params.limit = options.limit;
    }

    return db.prepare(query).all(params);
  },

  findById(id) {
    return db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  },

  findByCommentId(postId, commentId) {
    return db.prepare('SELECT * FROM comments WHERE post_id = ? AND comment_id = ?').get(postId, commentId);
  },

  findPending() {
    return db.prepare('SELECT * FROM comments WHERE status = ? ORDER BY scraped_at ASC').all('pending');
  },

  create(data) {
    const stmt = db.prepare(`
      INSERT INTO comments (
        listing_id, post_id, post_url, comment_id, author_name, author_profile_url,
        content, status
      ) VALUES (
        @listing_id, @post_id, @post_url, @comment_id, @author_name, @author_profile_url,
        @content, @status
      )
    `);

    const result = stmt.run({
      listing_id: data.listing_id || null,
      post_id: data.post_id,
      post_url: data.post_url || null,
      comment_id: data.comment_id || null,
      author_name: data.author_name || null,
      author_profile_url: data.author_profile_url || null,
      content: data.content || null,
      status: data.status || 'pending'
    });

    return this.findById(result.lastInsertRowid);
  },

  upsert(data) {
    const existing = this.findByCommentId(data.post_id, data.comment_id);

    if (existing) {
      const stmt = db.prepare(`
        UPDATE comments SET
          author_name = COALESCE(@author_name, author_name),
          author_profile_url = COALESCE(@author_profile_url, author_profile_url),
          content = COALESCE(@content, content),
          post_url = COALESCE(@post_url, post_url),
          scraped_at = datetime('now')
        WHERE id = @id
      `);

      stmt.run({
        id: existing.id,
        author_name: data.author_name || null,
        author_profile_url: data.author_profile_url || null,
        content: data.content || null,
        post_url: data.post_url || null
      });

      return this.findById(existing.id);
    }

    return this.create(data);
  },

  updateApiResponse(id, data) {
    const stmt = db.prepare(`
      UPDATE comments SET
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
      external_contact_id: data.external_contact_id || null,
      external_lead_id: data.external_lead_id || null,
      request_payload: data.request_payload ? JSON.stringify(data.request_payload) : null,
      response_payload: data.response_payload ? JSON.stringify(data.response_payload) : null,
      status: data.status || 'sent',
      error_message: data.error_message || null
    });

    return this.findById(id);
  },

  markAsSent(id, externalIds, requestPayload, responsePayload) {
    return this.updateApiResponse(id, {
      external_contact_id: externalIds?.contact_id,
      external_lead_id: externalIds?.lead_id,
      request_payload: requestPayload,
      response_payload: responsePayload,
      status: 'sent'
    });
  },

  markAsFailed(id, requestPayload, responsePayload, errorMessage) {
    return this.updateApiResponse(id, {
      request_payload: requestPayload,
      response_payload: responsePayload,
      status: 'failed',
      error_message: errorMessage
    });
  },

  delete(id) {
    const comment = this.findById(id);
    if (!comment) return null;

    db.prepare('DELETE FROM comments WHERE id = ?').run(id);
    return comment;
  },

  count(options = {}) {
    let query = 'SELECT COUNT(*) as count FROM comments c';
    const conditions = [];
    const params = {};

    if (options.status) {
      conditions.push('c.status = @status');
      params.status = options.status;
    }

    if (options.post_id) {
      conditions.push('c.post_id = @post_id');
      params.post_id = options.post_id;
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    return db.prepare(query).get(params).count;
  },

  /**
   * Send a comment to external API
   */
  async sendToExternalApi(commentId) {
    const comment = this.findById(commentId);
    if (!comment) {
      logger.error(`Comment ${commentId} not found`);
      return { success: false, error: 'Comment not found' };
    }

    // Get the associated listing/post with group info
    let listing = null;
    let group = null;

    if (comment.listing_id) {
      listing = db.prepare(`
        SELECT l.*, g.name as group_name, g.url as group_url, g.facebook_group_id
        FROM listings l
        LEFT JOIN groups g ON l.group_id = g.id
        WHERE l.id = ?
      `).get(comment.listing_id);

      // Get the group if we have a group_id
      if (listing && listing.group_id) {
        group = db.prepare('SELECT * FROM groups WHERE id = ?').get(listing.group_id);
      }
    }

    try {
      logger.info(`Sending comment ${commentId} to external API...`);

      const result = await externalApi.ingestComment(comment, listing, group);

      if (result.success) {
        this.markAsSent(commentId, result.externalIds, result.requestPayload, result.responsePayload);
        logger.info(`Comment ${commentId} sent successfully`);
        return { success: true, externalIds: result.externalIds, data: result.data };
      } else {
        this.markAsFailed(commentId, result.requestPayload, result.responsePayload, JSON.stringify(result.error));
        logger.error(`Failed to send comment ${commentId}:`, result.error);
        return { success: false, error: result.error };
      }
    } catch (error) {
      this.markAsFailed(commentId, null, null, error.message);
      logger.error(`Error sending comment ${commentId}:`, error.message);
      return { success: false, error: error.message };
    }
  },

  /**
   * Send all pending comments to external API (one at a time)
   */
  async sendAllPending() {
    const pending = this.findPending();
    logger.info(`Found ${pending.length} pending comments to send`);

    const results = {
      total: pending.length,
      success: 0,
      failed: 0,
      errors: []
    };

    for (const comment of pending) {
      const result = await this.sendToExternalApi(comment.id);

      if (result.success) {
        results.success++;
      } else {
        results.failed++;
        results.errors.push({
          comment_id: comment.id,
          error: result.error
        });
      }

      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    logger.info(`Sent ${results.success}/${results.total} comments (${results.failed} failed)`);
    return results;
  }
};

module.exports = Comment;
