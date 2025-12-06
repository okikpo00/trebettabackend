// src/models/PoolEntry.js
const pool = require('../config/db');

async function create(entry) {
  // entry: { pool_id, option_id, user_id, wallet_id, share_slip_id, amount, fee, reference }
  const [res] = await pool.query(
    `INSERT INTO pool_entries (pool_id, option_id, user_id, wallet_id, share_slip_id, amount, fee, status, reference, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NOW())`,
    [entry.pool_id, entry.option_id, entry.user_id, entry.wallet_id || null, entry.share_slip_id || null, entry.amount, entry.fee || 0, entry.reference]
  );
  return res.insertId;
}

async function getById(id) {
  const [rows] = await pool.query('SELECT * FROM pool_entries WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function listByPool(poolId, { page = 1, limit = 50 } = {}) {
  const offset = (page - 1) * limit;
  const [rows] = await pool.query('SELECT * FROM pool_entries WHERE pool_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [poolId, Number(limit), Number(offset)]);
  return rows;
}

async function updateStatus(id, status) {
  await pool.query('UPDATE pool_entries SET status = ?, updated_at = NOW() WHERE id = ?', [status, id]);
}

module.exports = { create, getById, listByPool, updateStatus };
