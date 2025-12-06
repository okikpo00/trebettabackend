// src/controllers/adminPoolsController.js
const poolService = require('../services/poolService');
const payoutService = require('../services/payoutService');
const { logger } = require('../utils/logger'); 

exports.createPool = async (req, res) => {
  try {
    const adminId = req.user.id;
    const { title, description, type, min_entry, closing_date, include_rollover } = req.body;

    // Call your service with manual rollover flag
    const result = await poolService.createPool({
      title,
      description,
      type,
      min_entry,
      closing_date,
      created_by: adminId,
      includeRollover: include_rollover === true || include_rollover === 'true' // support both bool & string
    });

    return res.status(201).json({
      status: true,
      message: `Pool created successfully${result.rollover_included ? ' with rollover' : ''}`,
      data: result
    });
  } catch (e) {
    console.error('createPool err', e.message);
    return res.status(500).json({ status: false, message: e.message });
  }
};




exports.getPoolById = async (req, res) => {
  try {
    const pool = await poolService.getPoolById(req.params.id);
    if (!pool) {
      return res.status(404).json({ status: false, message: 'Pool not found' });
    }
    res.json({ status: true, data: pool });
  } catch (err) {
    console.error('getPoolById error:', err);
    res.status(500).json({ status: false, message: 'Server error', error: err.message });
  }
};

exports.addOption = async (req, res) => {
  try {
    const poolId = Number(req.params.id);
    const { title, metadata } = req.body;
    const r = await poolService.addOption(poolId, title, metadata || {});
    return res.status(201).json({ status: true, data: r });
  } catch (e) {
    console.error('addOption err', e.message);
    return res.status(500).json({ status: false, message: e.message });
  }
};

exports.lockPool = async (req, res) => {
  try {
    const poolId = Number(req.params.id);
    const r = await poolService.lockPool(poolId);
    return res.json({ status: true, data: r });
  } catch (e) {
    console.error('lockPool err', e.message);
    return res.status(500).json({ status: false, message: e.message });
  }
};

exports.settlePool = async (req, res) => {
  try {
    const poolId = Number(req.params.id);
    const { winning_option_id } = req.body;

    if (!poolId || !winning_option_id) {
      return res.status(400).json({ status: false, message: "Missing poolId or winning_option_id" });
    }

    const result = await payoutService.settlePool(poolId, Number(winning_option_id));

    return res.json({
      status: true,
      message: result.message || "Pool settled successfully",
      data: result,
    });
  } catch (err) {
    console.error("❌ settlePool error:", err);
    return res.status(500).json({
      status: false,
      message: err.message || "Server error during settlement",
    });
  }
};

exports.listPoolsByStatus = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const r = await poolService.listPoolsByStatus({ status, page, limit });
    return res.json({ status: true, data: r });
  } catch (e) {
    console.error('listPoolsByStatus err', e.message);
    return res.status(500).json({ status: false, message: e.message });
  }
};

exports.getPoolParticipants = async (req, res) => {
  try {
    const poolId = Number(req.params.id);
    const r = await poolService.fetchPoolParticipants(poolId);
    return res.json({ status: true, data: r });
  } catch (e) {
    console.error('getPoolParticipants err', e.message);
    return res.status(500).json({ status: false, message: e.message });
  }
};

exports.updatePool = async (req, res) => {
  try {
    const poolId = Number(req.params.id);
    const updates = req.body;
    const r = await poolService.updatePoolDetails(poolId, updates);
    return res.json({ status: true, data: r });
  } catch (e) {
    console.error('updatePool err', e.message);
    return res.status(500).json({ status: false, message: e.message });
  }
};



/**
 * GET /api/admin/pools/:id/ledger
 * Admin-only ledger view
 */
exports.getPoolLedger = async (req, res) => {
  try {
    const poolId = Number(req.params.id);
    if (!poolId) return res.status(400).json({ status: false, message: 'Invalid pool id' });

    // Admin request -> full view
    const ledger = await poolService.getPoolLedger(poolId, null, true);
    return res.json({ status: true, data: ledger });
  } catch (err) {
    logger && logger.error && logger.error('getPoolLedger err', err);
    return res.status(500).json({ status: false, message: 'Server error', error: err.message });
  }
};
