// src/services/winnerTickerService.js
const pool = require('../config/db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const TICKER_CACHE_KEY = 'home:winner_ticker';
const TICKER_CACHE_TTL = 60; // seconds

function maskUsername(u) {
  if (!u) return 'user';
  if (typeof u !== 'string') return 'user';
  if (u.length <= 2) return `${u[0]}*`;
  return `${u.slice(0, 3)}***`;
}

/**
 * Add a winner record (used by payout flow for 'auto' or admin UI for 'manual').
 * opts: { user_id, pool_id, amount_won, source = 'auto'|'manual', message = null }
 */
async function addWinner({ user_id, pool_id, amount_won, source = 'auto', message = null }, conn = null) {
  if (!user_id || !pool_id || !amount_won) {
    throw new Error('invalid_params');
  }

  const q = 'INSERT INTO winner_ticker (user_id, pool_id, amount_won, source, message, created_at) VALUES (?, ?, ?, ?, ?, NOW())';
  const params = [user_id, pool_id, amount_won, source === 'manual' ? 'manual' : 'auto', message || ''];

  // allow transaction connection to be passed in (e.g. from payoutService)
  if (conn && typeof conn.query === 'function') {
    const [res] = await conn.query(q, params);
    try { await cache.del(TICKER_CACHE_KEY); } catch (e) { logger && logger.warn && logger.warn('cache.del ticker error', e); }
    return { id: res.insertId };
  }

  const [res] = await pool.query(q, params);
  try { await cache.del(TICKER_CACHE_KEY); } catch (e) { logger && logger.warn && logger.warn('cache.del ticker error', e); }
  return { id: res.insertId };
}

/**
 * Returns top winners for public ticker (cached).
 * limit default 10
 */
async function listTopWinners(limit = 10) {
  // try cache
  try {
    const cached = await cache.get(TICKER_CACHE_KEY);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (e) {
    logger && logger.warn && logger.warn('winnerTicker cache.get error', e);
  }

  const sql = `
    SELECT wt.id, wt.user_id, u.username, wt.pool_id, p.title AS pool_title,
           wt.amount_won, wt.source, wt.message, wt.created_at
    FROM winner_ticker wt
    LEFT JOIN users u ON u.id = wt.user_id
    LEFT JOIN pools p ON p.id = wt.pool_id
    ORDER BY wt.amount_won DESC, wt.created_at DESC
    LIMIT ?
  `;
  const [rows] = await pool.query(sql, [Number(limit) || 10]);

  const mapped = (rows || []).map(r => ({
    id: r.id,
    username: maskUsername(r.username),
    pool_id: r.pool_id,
    pool_title: r.pool_title || null,
    amount: Number(r.amount_won || 0),
    source: r.source,
    message: r.message || null,
    created_at: r.created_at
  }));

  try {
    await cache.set(TICKER_CACHE_KEY, JSON.stringify(mapped), TICKER_CACHE_TTL);
  } catch (e) {
    logger && logger.warn && logger.warn('winnerTicker cache.set failed', e);
  }

  return mapped;
}

/**
 * Admin listing (paginated) — returns raw rows for admin.
 */
async function adminList({ page = 1, limit = 50 } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Number(limit) || 50);
  const offset = (safePage - 1) * safeLimit;

  const sql = `
    SELECT wt.id, wt.user_id, u.username, wt.pool_id, p.title AS pool_title,
           wt.amount_won, wt.source, wt.message, wt.created_at
    FROM winner_ticker wt
    LEFT JOIN users u ON u.id = wt.user_id
    LEFT JOIN pools p ON p.id = wt.pool_id
    ORDER BY wt.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const [rows] = await pool.query(sql, [safeLimit, offset]);

  return rows.map(r => ({
    id: r.id,
    user_id: r.user_id,
    username: r.username || null,
    pool_id: r.pool_id,
    pool_title: r.pool_title || null,
    amount: Number(r.amount_won || 0),
    source: r.source,
    message: r.message || null,
    created_at: r.created_at
  }));
}

/**
 * Admin delete (optional) — removes an entry and clears cache
 */
async function adminDelete(id) {
  const [res] = await pool.query('DELETE FROM winner_ticker WHERE id = ?', [id]);
  try { await cache.del(TICKER_CACHE_KEY); } catch (e) { logger && logger.warn && logger.warn('cache.del ticker error', e); }
  return { deleted: res.affectedRows };
}

module.exports = {
  addWinner,
  listTopWinners,
  adminList,
  adminDelete,
  maskUsername
};
