const externalApi = require('./externalApi');
const Group = require('../models/Group');
const logger = require('../utils/logger');

class GroupSyncService {
  constructor() {
    this.lastSync = null;
    this.syncInProgress = false;
  }

  /**
   * Fetch groups from CRM API
   * @param {boolean} activeOnly - Only fetch active groups
   * @returns {Array} Array of groups from CRM
   */
  async fetchGroupsFromCrm(activeOnly = true) {
    try {
      logger.info('Fetching groups from CRM...');

      const result = await externalApi.getFacebookGroups(activeOnly);

      if (!result.success) {
        logger.error('Failed to fetch groups from CRM:', result.error);
        return [];
      }

      const groups = result.data?.groups || result.data || [];
      logger.info(`Fetched ${groups.length} groups from CRM`);

      return groups;
    } catch (error) {
      logger.error('Error fetching groups from CRM:', error.message);
      return [];
    }
  }

  /**
   * Refresh local groups from CRM
   * Syncs local database with CRM group data
   * @returns {Object} Sync results { added, updated, deactivated }
   */
  async refreshGroups() {
    if (this.syncInProgress) {
      logger.warn('Group sync already in progress, skipping');
      return { skipped: true };
    }

    this.syncInProgress = true;
    const results = { added: 0, updated: 0, deactivated: 0, errors: 0 };

    try {
      logger.info('Starting group refresh from CRM...');

      // Fetch all groups (including inactive) from CRM
      const crmGroups = await this.fetchGroupsFromCrm(false);

      if (crmGroups.length === 0) {
        logger.warn('No groups received from CRM');
        this.syncInProgress = false;
        return results;
      }

      // Get local groups
      const localGroups = Group.findAll();
      const localGroupMap = new Map();

      for (const g of localGroups) {
        if (g.facebook_group_id) {
          localGroupMap.set(g.facebook_group_id, g);
        }
      }

      // Track which CRM groups we've seen (by both facebook_group_id and url)
      const seenCrmGroupIds = new Set();
      const seenCrmUrls = new Set();

      // Build URL map for local groups
      const localUrlMap = new Map();
      for (const g of localGroups) {
        if (g.url) {
          localUrlMap.set(g.url, g);
        }
      }

      // Sync CRM groups to local
      for (const crmGroup of crmGroups) {
        try {
          const facebookGroupId = crmGroup.facebook_group_id?.toString() || null;
          const groupUrl = crmGroup.url || null;

          // Track what we've seen
          if (facebookGroupId) seenCrmGroupIds.add(facebookGroupId);
          if (groupUrl) seenCrmUrls.add(groupUrl);

          // Find existing group by facebook_group_id OR url
          let localGroup = null;
          if (facebookGroupId) {
            localGroup = localGroupMap.get(facebookGroupId);
          }
          if (!localGroup && groupUrl) {
            localGroup = localUrlMap.get(groupUrl);
          }

          if (localGroup) {
            // Update existing group
            Group.update(localGroup.id, {
              external_id: crmGroup.id,
              facebook_group_id: facebookGroupId || localGroup.facebook_group_id,
              url: groupUrl || localGroup.url,
              name: crmGroup.name,
              is_active: crmGroup.is_active ? 1 : 0,
              polling_interval_min: crmGroup.polling_interval_min
            });
            results.updated++;
          } else {
            // Create new group
            Group.create({
              external_id: crmGroup.id,
              facebook_group_id: facebookGroupId,
              url: groupUrl || (facebookGroupId ? `https://www.facebook.com/groups/${facebookGroupId}` : null),
              name: crmGroup.name,
              is_active: crmGroup.is_active ? 1 : 0,
              polling_interval_min: crmGroup.polling_interval_min || 60
            });
            results.added++;
          }
        } catch (err) {
          logger.error(`Error syncing CRM group: ${err.message}`);
          results.errors++;
        }
      }

      // Deactivate local groups that are not in CRM (check by both id and url)
      for (const [facebookGroupId, localGroup] of localGroupMap) {
        if (!seenCrmGroupIds.has(facebookGroupId) && !seenCrmUrls.has(localGroup.url) && localGroup.is_active) {
          logger.info(`Deactivating local group ${facebookGroupId} (not in CRM)`);
          Group.update(localGroup.id, { is_active: 0 });
          results.deactivated++;
        }
      }

      this.lastSync = new Date();
      logger.info(`Group refresh complete: ${results.added} added, ${results.updated} updated, ${results.deactivated} deactivated, ${results.errors} errors`);

      return results;
    } catch (error) {
      logger.error('Group refresh failed:', error.message);
      results.errors++;
      return results;
    } finally {
      this.syncInProgress = false;
    }
  }

  /**
   * Report a group error to CRM (e.g., access denied)
   * This will mark the group as inactive in CRM
   * @param {string} facebookGroupId - Facebook group ID
   * @param {string} reason - Error reason
   */
  async reportGroupError(facebookGroupId, reason) {
    try {
      logger.info(`Reporting group error for ${facebookGroupId}: ${reason}`);

      // Find local group to get CRM ID (by facebook_group_id)
      let localGroup = Group.findByFacebookGroupId(facebookGroupId);

      // If not found, try to find by URL (in case facebookGroupId is actually a URL)
      if (!localGroup && facebookGroupId?.includes('facebook.com')) {
        localGroup = Group.findByUrl(facebookGroupId);
      }

      if (!localGroup || !localGroup.external_id) {
        logger.warn(`Cannot report error: group ${facebookGroupId} not found or has no external_id`);
        return { success: false, error: 'Group not found or no external ID' };
      }

      // Update group in CRM to mark as inactive
      const result = await externalApi.updateFacebookGroup(localGroup.external_id, {
        is_active: false,
        error_reason: reason
      });

      if (result.success) {
        // Also mark local group as inactive
        Group.markInactiveByFacebookId(localGroup.facebook_group_id || localGroup.url, reason);
        logger.info(`Group ${facebookGroupId} marked as inactive in CRM and locally`);
      }

      return result;
    } catch (error) {
      logger.error(`Error reporting group error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get sync status
   */
  getStatus() {
    return {
      lastSync: this.lastSync ? this.lastSync.toISOString() : null,
      syncInProgress: this.syncInProgress
    };
  }
}

// Export singleton instance
const groupSync = new GroupSyncService();
module.exports = groupSync;
