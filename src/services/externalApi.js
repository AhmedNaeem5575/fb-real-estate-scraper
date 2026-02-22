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
        facebook_group_id: groupData.facebook_group_id,
        name: groupData.name,
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

      // Build the payload according to Section 5.5 spec
      const payload = {
        agency_id: DEFAULT_AGENCY_ID,
        group: {
          facebook_group_id: facebookGroupId,
          name: group.name
        },
        post: {
          facebook_post_id: listing.post_id,
          author_name: listing.owner_name,
          message: listing.raw_content || listing.title,
          post_type: postType,
          property_type: propertyType,
          permalink: listing.post_url
        },
        prospect_contact: null,
        news_lead: null
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
        description: listing.raw_content || '',
        address: listing.location || '',
        estimated_price: estimatedPrice,
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
          facebook_post_id: postId,
          facebook_group_id: groupId,
          permalink: permalink
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
    if (!fullName) return { firstName: null, lastName: null };

    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) {
      return { firstName: parts[0], lastName: null };
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
    if (!url) return null;

    // Try to extract from URL patterns
    const match = url.match(/groups\/(\d+)/);
    if (match) return match[1];

    // Return URL as fallback
    return url;
  }
}

module.exports = new ExternalApiService();
