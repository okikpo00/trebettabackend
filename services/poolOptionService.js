// src/services/poolOptionService.js
const pool = require('../config/db');
const logger = require('../utils/logger');
const { sendInApp, sendEmail } = require('../utils/notify');
const { addToRolloverBalance } = require('../utils/rolloverHelper');

const poolOptionService = {
  /**
   * Create a new option for a pool
   */
  async createOption(pool_id, title) {
    try {
      const [existing] = await pool.query(
        'SELECT * FROM pool_options WHERE pool_id = ? AND title = ?',
        [pool_id, title]
      );
      if (existing.length > 0) {
        throw new Error('Option with same title already exists');
      }

      const [result] = await pool.query(
        'INSERT INTO pool_options (pool_id, title, status, created_at) VALUES (?, ?, ?, NOW())',
        [pool_id, title, 'active']
      );

      const [option] = await pool.query(
        'SELECT * FROM pool_options WHERE id = ?',
        [result.insertId]
      );

      return option[0];
    } catch (err) {
      logger.error('createOption error', err);
      throw err;
    }
  },

  /**
   * Update an existing pool option
   */
  async updateOption(pool_id, option_id, title) {
    try {
      await pool.query(
        'UPDATE pool_options SET title = ?, updated_at = NOW() WHERE id = ? AND pool_id = ?',
        [title, option_id, pool_id]
      );

      const [option] = await pool.query(
        'SELECT * FROM pool_options WHERE id = ?',
        [option_id]
      );

      return option[0];
    } catch (err) {
      logger.error('updateOption error', err);
      throw err;
    }
  },

  /**
   * Delete a pool option
   */
  async deleteOption(pool_id, option_id) {
    try {
      await pool.query('DELETE FROM pool_options WHERE id = ? AND pool_id = ?', [
        option_id,
        pool_id,
      ]);

      return { id: option_id, deleted: true };
    } catch (err) {
      logger.error('deleteOption error', err);
      throw err;
    }
  },



  /**
   * Eliminate an option from a pool
   * - Marks the option as eliminated
   * - Marks all related pool_entries as 'lost'
   * - Notifies affected users
   * - If all options are eliminated, mark pool as 'rollover'
   */
  async eliminateOption(pool_id, option_id) {
    const connection = await pool.getConnection();

    try {
      await connection.beginTransaction();
      logger.info(`🚫 Eliminating option ${option_id} from pool ${pool_id}...`);

      // 1️⃣ Mark option as eliminated
      const [updateRes] = await connection.query(
        'UPDATE pool_options SET status = "eliminated", updated_at = NOW() WHERE id = ? AND pool_id = ?',
        [option_id, pool_id]
      );
      if (updateRes.affectedRows === 0) throw new Error('Option not found or already eliminated');
      logger.info(`✅ Option ${option_id} marked as eliminated.`);

      // 2️⃣ Fetch all users that picked this option
      const [affectedEntries] = await connection.query(
        'SELECT id, user_id, amount FROM pool_entries WHERE pool_id = ? AND option_id = ? AND (status = "active" OR status = "joined")',
        [pool_id, option_id]
      );
      logger.info(`👥 ${affectedEntries.length} entries affected by elimination.`);

      // 3️⃣ Mark entries as lost
      if (affectedEntries.length > 0) {
        await connection.query(
          'UPDATE pool_entries SET status = "lost", updated_at = NOW() WHERE pool_id = ? AND option_id = ? AND (status = "active" OR status = "joined")',
          [pool_id, option_id]
        );

        // Send user notifications
        for (const entry of affectedEntries) {
          await sendInApp(
            entry.user_id,
            '⚠️ Option Eliminated',
            `Your selected option in Pool #${pool_id} has been eliminated. Better luck next time!`
          );
          await sendEmail(
            entry.user_id,
            'Option Eliminated',
            `Hi there, your chosen option in Pool #${pool_id} has been eliminated.`
          );
        }
      }

      // 4️⃣ Check if all pool options are now eliminated
      const [remainingOptions] = await connection.query(
        'SELECT COUNT(*) AS remaining FROM pool_options WHERE pool_id = ? AND status = "active"',
        [pool_id]
      );

      if (remainingOptions[0].remaining === 0) {
        logger.warn(`⚠️ All options eliminated for pool ${pool_id}. Marking as rollover...`);

        // Mark pool as rollover
        await connection.query(
          'UPDATE pools SET status = "rollover", updated_at = NOW() WHERE id = ?',
          [pool_id]
        );

        // Add remaining funds to rollover balance
        await addToRolloverBalance(pool_id);

        logger.info(`♻️ Pool ${pool_id} marked as rollover and funds transferred.`);
      }

      await connection.commit();
      logger.info(`✅ Elimination process for option ${option_id} completed successfully.`);
      return { success: true, message: 'Option eliminated successfully' };
    } catch (err) {
      await connection.rollback();
      logger.error('❌ Error eliminating option:', err);
      throw err;
    } finally {
      connection.release();
      logger.info('🔓 Connection released.');
    }
  },



  /**
   * Get all options for a specific pool
   */
  async getPoolOptions(pool_id) {
    try {
      const [options] = await pool.query(
        'SELECT * FROM pool_options WHERE pool_id = ? ORDER BY created_at ASC',
        [pool_id]
      );
      return options;
    } catch (err) {
      logger.error('getPoolOptions error', err);
      throw err;
    }
  },
};

module.exports = poolOptionService;