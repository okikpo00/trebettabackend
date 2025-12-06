// src/controllers/poolsController.js
const userPoolService = require('../services/userPoolService');
const winmeterService = require('../services/winmeterService');
const logger = require('../utils/logger');
const pool = require('../config/db');
 const slipService = require('../services/slipService');
/**
 * GET /pools
 */

/**
 * GET /pools
 */
exports.listPools = async (req, res) => {
  try {
    const { type, page, limit, search } = req.query;
    const rows = await userPoolService.listPools({
      type,
      page: Number(page || 1),
      limit: Number(limit || 20),
      search
    });
    return res.json({ status: true, data: rows });
  } catch (e) {
    logger && logger.error && logger.error('listPools err', e);
    return res
      .status(500)
      .json({ status: false, message: 'Server error', error: e.message });
  }
};


/**
 * GET /pools/:id
 */
exports.getPool = async (req, res) => {
  try {
    const poolId = Number(req.params.id);
    const userId = req.user ? req.user.id : null;
    if (!poolId || isNaN(poolId)) return res.status(400).json({ status: false, message: 'Invalid pool id' });

    const p = await userPoolService.getPoolDetails(poolId, userId);
    return res.json({ status: true, data: p });
  } catch (e) {
    logger && logger.error && logger.error('getPool err', e);
    if (String(e.message).includes('not_found') || String(e.message).includes('pool_not_found')) {
      return res.status(404).json({ status: false, message: 'Pool not found' });
    }
    return res.status(500).json({ status: false, message: 'Server error', error: e.message });
  }
};

/**
 * POST /pools/:id/join
 */
exports.joinPool = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ status: false, message: 'Unauthorized' });
    }

    const userId = req.user.id;
    const poolId = Number(req.params.id);
    const optionId = Number(req.body.option_id);
    const amount = Number(req.body.amount);
    const reference = req.body.reference || null;

    if (!poolId || isNaN(poolId) || !optionId || !amount) {
      return res.status(400).json({
        status: false,
        message: 'pool id, option_id and amount required'
      });
    }

    // 1. Join pool via service (unchanged)
    const r = await userPoolService.joinPool({
      userId,
      poolId,
      optionId,
      amount,
      reference
    });

    // 2. Fresh pool snapshot including user entry (unchanged)
    const poolSnapshot = await userPoolService.getPoolDetails(poolId, userId);

    // 3. Create pool_join slip (best-effort)
    let slipId = null;
    try {
      const [[poolRow]] = await pool.query(
        'SELECT title, type FROM pools WHERE id = ? LIMIT 1',
        [poolId]
      );

      const [[optRow]] = await pool.query(
        'SELECT title FROM pool_options WHERE id = ? LIMIT 1',
        [optionId]
      );

      const [[userRow]] = await pool.query(
        'SELECT username FROM users WHERE id = ? LIMIT 1',
        [userId]
      );

      let userMasked = 'user';
      if (userRow && userRow.username) {
        userMasked =
          userRow.username.length <= 2
            ? `${userRow.username[0]}*`
            : `${userRow.username.slice(0, 3)}***`;
      }

      const slipPayload = {
        pool_title: poolRow?.title || '',
        option_title: optRow?.title || '',
        stake: Number(amount),
        pool_type: poolRow?.type || null,
        entry_reference: r.reference || reference || null,
        user_masked: userMasked,
        created_at: new Date().toISOString()
      };

      slipId = await slipService.createSlip(userId, 'pool_join', slipPayload);
    } catch (slipErr) {
      // Do NOT break join if slip fails
      logger && logger.warn && logger.warn('joinPool createSlip pool_join failed', slipErr);
      slipId = null;
    }

    // 4. Final response: slip_id at TOP LEVEL (as requested)
    return res.json({
      status: true,
      message: 'Joined successfully',
      slip_id: slipId, // frontend can redirect to /slip/:slip_id
      data: {
        entry: r,
        pool: poolSnapshot
      }
    });
  } catch (e) {
    logger && logger.error && logger.error('joinPool err', e);
    const msg = e.message || 'Join failed';

    if (msg === 'amount_below_min') {
      return res.status(400).json({
        status: false,
        message: 'Amount below pool minimum'
      });
    }

    if (msg === 'wallet_debit_failed') {
      return res.status(402).json({
        status: false,
        message: 'Insufficient balance'
      });
    }

    if (msg === 'already_joined') {
      return res.status(400).json({
        status: false,
        message: 'You already joined this pool'
      });
    }

    return res.status(400).json({
      status: false,
      message: msg
    });
  }
};


/**
 * GET /pools/my
 */
exports.listMyPools = async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ status: false, message: 'Unauthorized' });
    const userId = req.user.id;
    const { page, limit } = req.query;
    const rows = await userPoolService.listMyPools(userId, { page: Number(page||1), limit: Number(limit||50) });
    return res.json({ status: true, data: rows });
  } catch (e) {
    logger && logger.error && logger.error('listMyPools err', e);
    return res.status(500).json({ status: false, message: 'Server error', error: e.message });
  }
};

/**
 * GET /pools/recent-activity
 */
exports.recentActivity = async (req, res) => {
  try {
    const data = await userPoolService.recentActivity({ limit: Number(req.query.limit || 20) });
    return res.json({ status: true, data });
  } catch (e) {
    logger && logger.error && logger.error('recentActivity err', e);
    return res.status(500).json({ status: false, message: 'Server error', error: e.message });
  }
};

/**
 * GET /pools/:id/winmeter
 */
exports.getWinmeter = async (req, res) => {
  try {
    const poolId = Number(req.params.id);
    const optionId = Number(req.query.option_id);
    const userId = req.query.user_id ? Number(req.query.user_id) : (req.user ? req.user.id : null);
    const stake = req.query.stake ? Number(req.query.stake) : null;

    if (!poolId || isNaN(poolId)) return res.status(400).json({ status: false, message: 'Invalid pool id' });
    if (!optionId || isNaN(optionId)) return res.status(400).json({ status: false, message: 'option_id required' });

    const data = await winmeterService.getWinmeter(poolId, optionId, userId, stake);
    return res.json({ status: true, data });
  } catch (e) {
    logger && logger.error && logger.error('getWinmeter err', e);
    return res.status(500).json({ status: false, message: 'Server error', error: e.message });
  }
};




// ---------------------------------------------------------
// GET POOL LEDGER (settled pools only)
// ---------------------------------------------------------
exports.getPoolLedger = async (req, res) => {
  try {
    const poolId = Number(req.params.id);
    console.log('[POOLS] getPoolLedger › poolId:', poolId);

    if (!poolId || isNaN(poolId)) {
      return res.status(400).json({ status: false, message: 'Invalid pool id' });
    }

    const data = await userPoolService.getPoolLedger(poolId);

    return res.json({
      status: true,
      data
    });

  } catch (err) {
    logger && logger.error && logger.error('getPoolLedger ERROR', err);

    const msg = err.message || '';

    if (msg === 'pool_not_found') {
      return res.status(404).json({ status: false, message: 'Pool not found' });
    }

    if (msg === 'pool_not_settled') {
      return res.status(400).json({ status: false, message: 'Pool is not settled yet' });
    }

    if (msg === 'invalid_pool_id') {
      return res.status(400).json({ status: false, message: 'Invalid pool id' });
    }

    return res.status(500).json({
      status: false,
      message: 'Server error',
      error: err.message
    });
  }
};
