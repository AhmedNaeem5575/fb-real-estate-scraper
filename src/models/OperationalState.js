const { db } = require('../config/database');
const logger = require('../utils/logger');

const OperationalState = {
  /**
   * Get current operational state
   */
  get() {
    const row = db.prepare('SELECT * FROM operational_state WHERE id = 1').get();
    if (!row) {
      // Return default state if not found
      return {
        id: 1,
        can_operate: 0,
        manual_blocked: 0,
        daily_enabled: 0,
        daily_flag_date: null,
        reason: null,
        last_checked: null,
        api_key_valid: 1,
        cached_can_operate: 0,
        updated_at: null
      };
    }
    return row;
  },

  /**
   * Update operational state
   * @param {Object} state - State object with fields to update
   */
  update(state) {
    const fields = [];
    const values = { id: 1 };

    if (state.can_operate !== undefined) {
      fields.push('can_operate = @can_operate');
      values.can_operate = state.can_operate ? 1 : 0;
    }
    if (state.manual_blocked !== undefined) {
      fields.push('manual_blocked = @manual_blocked');
      values.manual_blocked = state.manual_blocked ? 1 : 0;
    }
    if (state.daily_enabled !== undefined) {
      fields.push('daily_enabled = @daily_enabled');
      values.daily_enabled = state.daily_enabled ? 1 : 0;
    }
    if (state.daily_flag_date !== undefined) {
      fields.push('daily_flag_date = @daily_flag_date');
      values.daily_flag_date = state.daily_flag_date;
    }
    if (state.reason !== undefined) {
      fields.push('reason = @reason');
      values.reason = state.reason;
    }
    if (state.last_checked !== undefined) {
      fields.push('last_checked = @last_checked');
      values.last_checked = state.last_checked;
    }
    if (state.api_key_valid !== undefined) {
      fields.push('api_key_valid = @api_key_valid');
      values.api_key_valid = state.api_key_valid ? 1 : 0;
    }
    if (state.cached_can_operate !== undefined) {
      fields.push('cached_can_operate = @cached_can_operate');
      values.cached_can_operate = state.cached_can_operate ? 1 : 0;
    }

    if (fields.length === 0) return this.get();

    fields.push("updated_at = datetime('now')");

    const stmt = db.prepare(`
      UPDATE operational_state
      SET ${fields.join(', ')}
      WHERE id = @id
    `);

    stmt.run(values);
    logger.info('Operational state updated:', JSON.stringify(values));
    return this.get();
  },

  /**
   * Set API key validity status
   * @param {boolean} valid - Whether API key is valid
   */
  setApiKeyValid(valid) {
    return this.update({ api_key_valid: valid ? 1 : 0 });
  },

  /**
   * Set cached can_operate value
   * @param {boolean} canOperate - Cached operational status
   */
  setCachedCanOperate(canOperate) {
    return this.update({ cached_can_operate: canOperate ? 1 : 0 });
  },

  /**
   * Update last checked timestamp
   */
  touchLastChecked() {
    return this.update({ last_checked: new Date().toISOString() });
  }
};

module.exports = OperationalState;
