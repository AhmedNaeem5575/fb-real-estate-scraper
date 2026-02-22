const express = require('express');
const router = express.Router();
const Group = require('../models/Group');
const logger = require('../utils/logger');

// GET /api/groups - List all groups
router.get('/', (req, res) => {
  try {
    const groups = Group.findAll();
    res.json({ success: true, data: groups });
  } catch (error) {
    logger.error('Error fetching groups:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch groups' });
  }
});

// GET /api/groups/:id - Get single group
router.get('/:id', (req, res) => {
  try {
    const group = Group.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }
    res.json({ success: true, data: group });
  } catch (error) {
    logger.error('Error fetching group:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch group' });
  }
});

// POST /api/groups - Add new group
router.post('/', (req, res) => {
  try {
    const { url, name, is_active, facebook_group_id, polling_interval_min } = req.body;

    // Either url or facebook_group_id is required
    if (!url && !facebook_group_id) {
      return res.status(400).json({
        success: false,
        error: 'Either URL or facebook_group_id is required'
      });
    }

    // Basic FB group URL validation if URL is provided
    if (url && !url.includes('facebook.com/groups/')) {
      return res.status(400).json({ success: false, error: 'Invalid Facebook group URL' });
    }

    const group = Group.create({
      url,
      name,
      is_active,
      facebook_group_id,
      polling_interval_min
    });
    res.status(201).json({ success: true, data: group });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ success: false, error: 'Group already exists' });
    }
    logger.error('Error creating group:', error.message);
    res.status(500).json({ success: false, error: 'Failed to create group' });
  }
});

// PUT /api/groups/:id - Update group
router.put('/:id', (req, res) => {
  try {
    const existing = Group.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }

    const { url, name, is_active, facebook_group_id, polling_interval_min } = req.body;
    const group = Group.update(req.params.id, {
      url,
      name,
      is_active,
      facebook_group_id,
      polling_interval_min
    });
    res.json({ success: true, data: group });
  } catch (error) {
    if (error.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ success: false, error: 'Group already exists' });
    }
    logger.error('Error updating group:', error.message);
    res.status(500).json({ success: false, error: 'Failed to update group' });
  }
});

// DELETE /api/groups/:id - Remove group
router.delete('/:id', (req, res) => {
  try {
    const group = Group.delete(req.params.id);
    if (!group) {
      return res.status(404).json({ success: false, error: 'Group not found' });
    }
    res.json({ success: true, data: group, message: 'Group deleted successfully' });
  } catch (error) {
    logger.error('Error deleting group:', error.message);
    res.status(500).json({ success: false, error: 'Failed to delete group' });
  }
});

// POST /api/groups/sync - Sync groups from external API
router.post('/sync', async (req, res) => {
  try {
    const groups = await Group.syncFromApi();
    res.json({
      success: true,
      message: `Synced ${groups.length} groups from external API`,
      data: groups
    });
  } catch (error) {
    logger.error('Error syncing groups:', error.message);
    res.status(500).json({ success: false, error: 'Failed to sync groups' });
  }
});

module.exports = router;
