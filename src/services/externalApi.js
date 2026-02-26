const axios = require('axios');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

const API_KEY = process.env.EXTERNAL_API_KEY || '0V2jJfx1C537PHYrALs3';
const API_BASE_URL = process.env.EXTERNAL_API_URL || 'https://professionecasa-roma-furio-camillo.nowcrm.it';
const API_PREFIX = '/api/v1/facebook-ingest';
const DEFAULT_AGENCY_ID = parseInt(process.env.DEFAULT_AGENCY_ID) || 1;

class ExternalApiService {
  constructor() {
    this.axios = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Api-Key': API_KEY
      },
      timeout: 30000
    });
  }

  /**
   * Clean message content by removing Facebook UI noise and anti-scraping artifacts
   */
  cleanMessage(message) {
    if (!message) return '';

    let cleaned = message
      // Remove all "Facebook" occurrences (anti-scraping noise)
      .replace(/Facebook/gi, '')
      // Remove single character lines (anti-scraping obfuscation)
      .split('\n')
      .filter(line => {
        const trimmed = line.trim();
        // Skip lines that are single chars, numbers, or symbols
        if (trimmed.length <= 1) return false;
        // Skip lines that are just whitespace
        if (!trimmed.trim()) return false;
        return true;
      })
      .join('\n')
      // Remove UI elements and noise
      .replace(/Write a public comment.*/gs, '')
      .replace(/Write something\.\.\..*/gi, '')
      .replace(/Like\s*Comment\s*Share/gi, '')
      .replace(/Like\s*Reply\s*Share/gi, '')
      .replace(/Like\s*Share/gi, '')
      .replace(/See more|See less|See original|Rate this translation/gi, '')
      .replace(/All reactions:?\s*\d*/gi, '')
      .replace(/\d+\s*(comments?|reactions?|likes?|shares?)/gi, '')
      .replace(/View more comments/gi, '')
      .replace(/Submit your first comment.*/gi, '')
      .replace(/·\s*Share\s*·\s*Edit/gi, '')
      .replace(/\d+[mhdwy]\s*$/gim, '') // Time indicators like "5h", "2d"
      .replace(/Edited\s*$/gim, '')
      // Remove admin/moderator labels
      .replace(/^(Admin|Moderator|Agorà Ammin)\s*$/gim, '')
      // Clean up excessive newlines
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return cleaned;
  }

  /**
   * Get headers for a request
   */
  getHeaders() {
    return {
      'X-Request-Id': uuidv4(),
      'Idempotency-Key': uuidv4()
    };
  }

  /**
   * Fetch groups to monitor from external API
   * Note: The API doesn't have a GET groups endpoint, so we'll need to
   * maintain groups locally or assume they're pre-configured in the external system
   */
  async getGroups() {
    // The API contract doesn't show a GET groups endpoint
    // Groups are upserted when we send posts
    // For now, return empty - groups should be configured locally
    logger.warn('External API does not have a GET groups endpoint');
    return [];
  }

  /**
   * Upsert a group to external API
   */
  async upsertGroup(groupData) {
    try {
      const payload = {
        facebook_group_id: groupData.facebook_group_id || '',
        name: groupData.name || '',
        is_active: groupData.is_active ?? true,
        polling_interval_min: groupData.polling_interval_min || 60
      };

      const response = await this.axios.post(
        `${API_PREFIX}/groups/upsert`,
        payload,
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      logger.error('Error upserting group:', error.message);
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Ingest a complete post with contact and lead info
   * Uses the single orchestrated endpoint (Section 5.5)
   */
  async ingestPost(listing, group) {
    try {
      // Parse owner name into first/last name
      const nameParts = this.parseName(listing.owner_name);

      // Parse price to number
      const estimatedPrice = this.parsePrice(listing.price);

      // Map listing_type to post_type
      const postType = this.mapPostType(listing.listing_type);

      // Detect property type
      const propertyType = listing.property_type || this.detectPropertyType(listing.raw_content);

      // Extract group ID
      const facebookGroupId = group.facebook_group_id || this.extractGroupId(group.url);

      // Clean the message content
      const cleanedMessage = this.cleanMessage(listing.raw_content || listing.title);

      // Build the payload according to Section 5.5 spec
      const payload = {
        agency_id: DEFAULT_AGENCY_ID,
        group: {
          facebook_group_id: facebookGroupId || '',
          name: group.name || ''
        },
        post: {
          facebook_post_id: listing.post_id || '',
          author_name: listing.owner_name || '',
          message: cleanedMessage,
          post_type: postType || '',
          property_type: propertyType || '',
          permalink: listing.post_url || ''
        },
        prospect_contact: {},
        news_lead: {}
      };

      // Add prospect contact if we have name or contact info (Section 5.5 simplified structure)
      if (nameParts.firstName || listing.contact_info || listing.email) {
        payload.prospect_contact = {
          first_name: nameParts.firstName || '',
          last_name: nameParts.lastName || '',
          phone: listing.contact_info || '',
          email: listing.email || '',
          force: false
        };
      }

      // Add news lead (Section 5.5 simplified structure)
      payload.news_lead = {
        title: listing.title || '',
        description: cleanedMessage,
        address: listing.location || '',
        estimated_price: estimatedPrice || 0,
        property_type: propertyType || 'residential'
      };

      const url = `${API_BASE_URL}${API_PREFIX}/ingest`;
      const headers = this.getHeaders();

      // Log request details
      logger.info('=== External API Request ===');
      logger.info(`URL: ${url}`);
      logger.info(`Headers: ${JSON.stringify({ ...this.axios.defaults.headers, ...headers })}`);
      logger.info(`Payload: ${JSON.stringify(payload, null, 2)}`);

      const response = await this.axios.post(
        `${API_PREFIX}/ingest`,
        payload,
        { headers }
      );

      // Log response
      logger.info('=== External API Response ===');
      logger.info(`Status: ${response.status}`);
      logger.info(`Data: ${JSON.stringify(response.data, null, 2)}`);

      // Extract IDs from response
      const responseData = response.data?.data || {};
      const externalPostId = responseData.post?.id || null;
      const externalContactId = responseData.prospect_contact?.id || null;
      const externalLeadId = responseData.news_lead?.id || null;

      return {
        success: true,
        data: response.data,
        requestPayload: payload,
        responsePayload: response.data,
        externalIds: {
          post_id: externalPostId,
          contact_id: externalContactId,
          lead_id: externalLeadId
        }
      };
    } catch (error) {
      // Log error details
      logger.error('=== External API Error ===');
      logger.error(`URL: ${API_BASE_URL}${API_PREFIX}/ingest`);
      logger.error(`Message: ${error.message}`);
      if (error.response) {
        logger.error(`Status: ${error.response.status}`);
        logger.error(`Response: ${JSON.stringify(error.response.data, null, 2)}`);
      }

      return {
        success: false,
        error: error.response?.data || error.message,
        requestPayload: listing,
        responsePayload: error.response?.data || { error: error.message }
      };
    }
  }

  /**
   * Check if a post is a duplicate
   */
  async checkPostDuplicate(postId, groupId, permalink) {
    try {
      const response = await this.axios.post(
        `${API_PREFIX}/posts/check-duplicate`,
        {
          facebook_post_id: postId || '',
          facebook_group_id: groupId || '',
          permalink: permalink || ''
        },
        { headers: this.getHeaders() }
      );

      return {
        success: true,
        data: response.data
      };
    } catch (error) {
      return {
        success: false,
        error: error.response?.data || error.message
      };
    }
  }

  /**
   * Parse a name into first and last name
   */
  parseName(fullName) {
    if (!fullName) return { firstName: '', lastName: '' };

    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) {
      return { firstName: parts[0], lastName: '' };
    }

    return {
      firstName: parts[0],
      lastName: parts.slice(1).join(' ')
    };
  }

  /**
   * Parse price string to number
   */
  parsePrice(priceStr) {
    if (!priceStr) return null;

    // Remove currency symbols and commas
    const cleaned = priceStr.replace(/[$€£₹,]/g, '').trim();

    // Extract number
    const match = cleaned.match(/[\d.]+/);
    if (match) {
      return parseFloat(match[0]);
    }

    return null;
  }

  /**
   * Map listing_type to API post_type
   */
  mapPostType(listingType) {
    const mapping = {
      'sale': 'selling',
      'rent': 'rent_offer',
      'buying': 'buying',
      'rent_search': 'rent_search'
    };

    return mapping[listingType] || 'selling';
  }

  /**
   * Detect property type from content
   */
  detectPropertyType(content) {
    if (!content) return 'residential';

    const lower = content.toLowerCase();

    // Commercial keywords
    if (/\b(office|commercial|shop|store|warehouse|retail|business)\b/.test(lower)) {
      return 'commercial';
    }

    // Land keywords
    if (/\b(land|plot|lot|acre|field|farm)\b/.test(lower)) {
      return 'land';
    }

    // Industrial keywords
    if (/\b(industrial|factory|manufacturing|plant)\b/.test(lower)) {
      return 'industrial';
    }

    return 'residential';
  }

  /**
   * Extract Facebook group ID from URL
   */
  extractGroupId(url) {
    if (!url) return '';

    // Try to extract from URL patterns
    const match = url.match(/groups\/(\d+)/);
    if (match) return match[1];

    // Return URL as fallback
    return url;
  }

  /**
   * Ingest a comment using POST /posts endpoint (Section 5.2.2)
   * Sends post data with comment object added
   */
  async ingestComment(comment, listing, group = null) {
    try {
      // Clean the comment message
      const cleanedCommentMessage = this.cleanMessage(comment.content);

      // Extract group ID
      const facebookGroupId = group?.facebook_group_id || this.extractGroupId(group?.url) || '';

      // Generate unique facebook_post_id for each comment
      // Combine post_id with comment_id to ensure uniqueness
      const uniquePostId = comment.comment_id
        ? `${listing?.post_id || 'post'}_${comment.comment_id}`
        : `${listing?.post_id || 'post'}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Build the payload according to Section 5.2.2 with comment object
      const payload = {
        facebook_post_id: uniquePostId,
        facebook_group_id: facebookGroupId,
        author_name: listing?.owner_name || '',
        message: this.cleanMessage(listing?.raw_content || listing?.title || ''),
        post_type: this.mapPostType(listing?.listing_type) || 'selling',
        property_type: listing?.property_type || this.detectPropertyType(listing?.raw_content) || 'residential',
        permalink: listing?.post_url || '',
        // Add comment object
        comment: {
          facebook_comment_id: comment.comment_id || '',
          author_name: comment.author_name || '',
          author_profile_url: comment.author_profile_url || '',
          message: cleanedCommentMessage,
          permalink: comment.post_url || listing?.post_url || ''
        }
      };

      const url = `${API_BASE_URL}${API_PREFIX}/posts`;
      const headers = this.getHeaders();

      logger.info('=== External API Request (Comment) ===');
      logger.info(`URL: ${url}`);
      logger.info(`Headers: ${JSON.stringify({ ...this.axios.defaults.headers, ...headers })}`);
      logger.info(`Payload: ${JSON.stringify(payload, null, 2)}`);

      const response = await this.axios.post(
        `${API_PREFIX}/posts`,
        payload,
        { headers }
      );

      // Log response
      logger.info('=== External API Response (Comment) ===');
      logger.info(`Status: ${response.status}`);
      logger.info(`Data: ${JSON.stringify(response.data, null, 2)}`);

      // Extract IDs from response
      const responseData = response.data?.data || {};
      const externalPostId = responseData.id || responseData.post?.id || '';
      const externalCommentId = responseData.comment?.id || '';

      return {
        success: true,
        data: response.data,
        requestPayload: payload,
        responsePayload: response.data,
        externalIds: {
          post_id: externalPostId,
          comment_id: externalCommentId
        }
      };
    } catch (error) {
      // Log error details
      logger.error('=== External API Error (Comment) ===');
      logger.error(`URL: ${API_BASE_URL}${API_PREFIX}/posts`);
      logger.error(`Message: ${error.message}`);
      if (error.response) {
        logger.error(`Status: ${error.response.status}`);
        logger.error(`Response: ${JSON.stringify(error.response.data, null, 2)}`);
      }

      return {
        success: false,
        error: error.response?.data || error.message,
        requestPayload: { comment, listing, group },
        responsePayload: error.response?.data || { error: error.message }
      };
    }
  }

  // ===========================================
  // Operational Control API Methods
  // ===========================================

  /**
   * Get bot operational status from CRM
   * GET /api/v1/facebook-bot/status
   */
  async getBotStatus() {
    try {
      const response = await this.axios.get(
        '/api/v1/facebook-bot/status',
        { headers: this.getHeaders(), timeout: 10000 }
      );

      return {
        success: true,
        data: response.data?.data || response.data,
        status: response.status
      };
    } catch (error) {
      const is401 = error.response?.status === 401;
      return {
        success: false,
        error: error.response?.data || error.message,
        status: error.response?.status,
        isUnauthorized: is401
      };
    }
  }

  /**
   * Ping CRM to check operational status (hourly check)
   * GET /api/v1/facebook-bot/ping
   */
  async pingBot() {
    try {
      const response = await this.axios.get(
        '/api/v1/facebook-bot/ping',
        { headers: this.getHeaders(), timeout: 10000 }
      );

      return {
        success: true,
        data: response.data?.data || response.data,
        status: response.status
      };
    } catch (error) {
      const is401 = error.response?.status === 401;
      return {
        success: false,
        error: error.response?.data || error.message,
        status: error.response?.status,
        isUnauthorized: is401
      };
    }
  }

  /**
   * Get Facebook groups from CRM
   * GET /api/v1/facebook-groups
   * @param {boolean} activeOnly - If true, only return active groups
   */
  async getFacebookGroups(activeOnly = true) {
    try {
      const params = activeOnly ? { is_active: 1 } : {};
      const response = await this.axios.get(
        '/api/v1/facebook-groups',
        { params, headers: this.getHeaders(), timeout: 10000 }
      );

      return {
        success: true,
        data: response.data?.data || response.data,
        status: response.status
      };
    } catch (error) {
      const is401 = error.response?.status === 401;
      return {
        success: false,
        error: error.response?.data || error.message,
        status: error.response?.status,
        isUnauthorized: is401
      };
    }
  }

  /**
   * Update a Facebook group in CRM
   * PUT /api/v1/facebook-groups/{id}
   * @param {number} id - Group ID in CRM
   * @param {Object} updates - Fields to update
   */
  async updateFacebookGroup(id, updates) {
    try {
      const response = await this.axios.put(
        `/api/v1/facebook-groups/${id}`,
        updates,
        { headers: this.getHeaders(), timeout: 10000 }
      );

      return {
        success: true,
        data: response.data?.data || response.data,
        status: response.status
      };
    } catch (error) {
      const is401 = error.response?.status === 401;
      return {
        success: false,
        error: error.response?.data || error.message,
        status: error.response?.status,
        isUnauthorized: is401
      };
    }
  }

  /**
   * Register a new Facebook group in CRM
   * POST /api/v1/facebook-groups
   * @param {Object} data - Group data to register
   */
  async registerFacebookGroup(data) {
    try {
      const response = await this.axios.post(
        '/api/v1/facebook-groups',
        data,
        { headers: this.getHeaders(), timeout: 10000 }
      );

      return {
        success: true,
        data: response.data?.data || response.data,
        status: response.status
      };
    } catch (error) {
      const is401 = error.response?.status === 401;
      return {
        success: false,
        error: error.response?.data || error.message,
        status: error.response?.status,
        isUnauthorized: is401
      };
    }
  }
}

module.exports = new ExternalApiService();
