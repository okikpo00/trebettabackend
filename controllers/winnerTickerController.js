// src/controllers/winnerTickerController.js
const tickerService = require('../services/winnerTickerService');
const logger = require('../utils/logger');

/**
 * GET /winners/ticker
 * public endpoint: returns top winners (cached)
 */
exports.listPublic = async (req, res) => {
  try {
    const limit = Number(req.query.limit || 10);
    const rows = await tickerService.listTopWinners(limit);
    return res.json({ status: true, data: rows });
  } catch (e) {
    logger && logger.error && logger.error('winnerTicker.listPublic err', e);
    return res.status(500).json({ status: false, message: 'Server error', error: e.message });
  }
};

/**
 * Admin: POST /admin/winners
 * body: { user_id, pool_id, amount, message? }
 */
exports.adminAdd = async (req, res) => {
  try {
    const { user_id, pool_id, amount, message } = req.body;
    if (!user_id || !pool_id || !amount) return res.status(400).json({ status: false, message: 'user_id, pool_id and amount required' });

    const r = await tickerService.addWinner({ user_id: Number(user_id), pool_id: Number(pool_id), amount_won: Number(amount), source: 'manual', message: message || '' });
    return res.status(201).json({ status: true, data: r });
  } catch (e) {
    logger && logger.error && logger.error('winnerTicker.adminAdd err', e);
    return res.status(500).json({ status: false, message: 'Server error', error: e.message });
  }
};

/**
 * Admin: GET /admin/winners
 * query: page, limit
 */
exports.adminList = async (req, res) => {
  try {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 50);
    const rows = await (require('../services/winnerTickerService')).adminList({ page, limit });
    return res.json({ status: true, data: rows });
  } catch (e) {
    logger && logger.error && logger.error('winnerTicker.adminList err', e);
    return res.status(500).json({ status: false, message: 'Server error', error: e.message });
  }
};

/**
 * Admin: DELETE /admin/winners/:id
 */
exports.adminDelete = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ status: false, message: 'Invalid id' });
    const r = await (require('../services/winnerTickerService')).adminDelete(id);
    return res.json({ status: true, data: r });
  } catch (e) {
    logger && logger.error && logger.error('winnerTicker.adminDelete err', e);
    return res.status(500).json({ status: false, message: 'Server error', error: e.message });
  }
};
