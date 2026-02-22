const express = require('express');
const router = express.Router();
const Listing = require('../models/Listing');
const Group = require('../models/Group');
const logger = require('../utils/logger');

// GET /api/listings - List all scraped listings
router.get('/', (req, res) => {
  try {
    const { listing_type, status, limit, offset, search, date_from, date_to, group_id } = req.query;
    const filterOptions = { listing_type, status, search, date_from, date_to, group_id };
    const listings = Listing.findAll({
      ...filterOptions,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined
    });
    res.json({
      success: true,
      data: listings,
      count: listings.length,
      total: Listing.count(filterOptions)
    });
  } catch (error) {
    logger.error('Error fetching listings:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch listings' });
  }
});

// GET /api/listings/:id - Get single listing
router.get('/:id', (req, res) => {
  try {
    const listing = Listing.findById(req.params.id);
    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }
    res.json({ success: true, data: listing });
  } catch (error) {
    logger.error('Error fetching listing:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch listing' });
  }
});

// GET /api/listings/group/:id - Get listings by group
router.get('/group/:id', (req, res) => {
  try {
    const group = Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }

    const listings = Listing.findByGroupId(req.params.id);
    res.json({
      success: true,
      data: listings,
      count: listings.length,
      group: group
    });
  } catch (error) {
    logger.error('Error fetching listings by group:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch listings' });
  }
});

// POST /api/listings/:id/send - Send a single listing to external API
router.post('/:id/send', async (req, res) => {
  try {
    const listing = Listing.findById(req.params.id);
    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    if (listing.status === 'sent') {
      return res.status(400).json({
        success: false,
        error: 'Listing already sent to external API',
        data: {
          external_post_id: listing.external_post_id,
          external_contact_id: listing.external_contact_id,
          external_lead_id: listing.external_lead_id
        }
      });
    }

    const result = await Listing.sendToExternalApi(req.params.id);

    if (result.success) {
      res.json({
        success: true,
        message: 'Listing sent to external API successfully',
        data: {
          listing_id: req.params.id,
          external_post_id: result.externalIds?.post_id,
          external_contact_id: result.externalIds?.contact_id,
          external_lead_id: result.externalIds?.lead_id
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to send listing to external API',
        details: result.error
      });
    }
  } catch (error) {
    logger.error('Error sending listing:', error.message);
    res.status(500).json({ success: false, error: 'Failed to send listing' });
  }
});

// POST /api/listings/send-pending - Send all pending listings to external API
router.post('/send-pending', async (req, res) => {
  try {
    const results = await Listing.sendAllPending();
    res.json({
      success: true,
      message: `Processed ${results.total} pending listings`,
      data: results
    });
  } catch (error) {
    logger.error('Error sending pending listings:', error.message);
    res.status(500).json({ success: false, error: 'Failed to send pending listings' });
  }
});

// GET /api/listings/stats/by-status - Get listing counts by status
router.get('/stats/by-status', (req, res) => {
  try {
    const pending = Listing.count({ status: 'pending' });
    const sent = Listing.count({ status: 'sent' });
    const failed = Listing.count({ status: 'failed' });
    const total = Listing.count();

    res.json({
      success: true,
      data: {
        total,
        pending,
        sent,
        failed
      }
    });
  } catch (error) {
    logger.error('Error fetching listing stats:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch stats' });
  }
});

// DELETE /api/listings/:id - Delete a listing
router.delete('/:id', (req, res) => {
  try {
    const listing = Listing.delete(req.params.id);
    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }
    res.json({ success: true, data: listing, message: 'Listing deleted successfully' });
  } catch (error) {
    logger.error('Error deleting listing:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete listing' });
  }
});

module.exports = router;
