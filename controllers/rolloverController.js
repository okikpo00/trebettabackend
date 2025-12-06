// controllers/rolloverController.js
const pool = require('../config/db');
const rolloverHelper = require('../utils/rolloverHelper');
const logger = require('../utils/logger');

/**
 * -------------------------------------------
 * GET ROLLOVER BALANCE
 * GET /api/admin/rollover
 * -------------------------------------------
 */
exports.getRolloverBalance = async (req, res) => {
  try {
    const { amount } = await rolloverHelper.getRolloverBalance();
    return res.status(200).json({
      status: true,
      message: "Rollover balance fetched successfully",
      balance: amount
    });
  } catch (err) {
    logger.error("getRolloverBalance err", err);
    return res.status(500).json({
      status: false,
      message: err.message
    });
  }
};


/**
 * -------------------------------------------
 * APPLY FULL ROLLOVER TO POOL
 * POST /api/admin/rollover/apply
 *
 * body: { pool_id }
 *
 * RULE:
 *  - ALWAYS use 100% of rollover balance
 *  - Deduct entire rollover balance
 *  - Add to pool total_pool_amount
 *  - Insert rollover_history row
 * -------------------------------------------
 */
exports.applyRolloverToPool = async (req, res) => {
  const adminId = req.user?.id;
  const poolId = Number(req.body.pool_id);

  if (!poolId) {
    return res.status(400).json({
      status: false,
      message: "pool_id is required"
    });
  }

  try {
    // 1. Load current balance
    const { amount } = await rolloverHelper.getRolloverBalance();
    const rolloverAmount = Number(amount || 0);

    if (rolloverAmount <= 0) {
      return res.status(400).json({
        status: false,
        message: "No rollover balance available to apply"
      });
    }

    // 2. Deduct FULL BALANCE (fixed: use pool, not undefined variable)
    const { consumed } = await rolloverHelper.consumeFromRollover(pool, rolloverAmount);

    if (consumed <= 0) {
      return res.status(400).json({
        status: false,
        message: "Failed to deduct rollover amount"
      });
    }

    // 3. Add deducted amount to the pool
    await pool.query(
      `UPDATE pools 
       SET total_pool_amount = total_pool_amount + ?
       WHERE id = ?`,
      [consumed, poolId]
    );

    // 4. Write history
    await pool.query(
      `INSERT INTO rollover_history (pool_id, amount, admin_id, created_at)
       VALUES (?, ?, ?, NOW())`,
      [poolId, consumed, adminId]
    );

    logger.info("Rollover applied", { poolId, adminId, amount: consumed });

    return res.json({
      status: true,
      message: "Rollover applied successfully",
      data: {
        pool_id: poolId,
        applied: consumed
      }
    });
  } catch (err) {
    logger.error("applyRolloverToPool err", err);
    return res.status(500).json({
      status: false,
      message: err.message
    });
  }
};


/**
 * -------------------------------------------
 * GET ROLLOVER HISTORY
 * GET /api/admin/rollover/history
 * -------------------------------------------
 */
exports.getRolloverHistory = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, pool_id, amount, admin_id, created_at
       FROM rollover_history
       ORDER BY created_at DESC`
    );

    return res.status(200).json({
      status: true,
      message: "Rollover history fetched successfully",
      data: rows
    });
  } catch (err) {
    logger.error("getRolloverHistory err", err);
    return res.status(500).json({
      status: false,
      message: err.message
    });
  }
};
