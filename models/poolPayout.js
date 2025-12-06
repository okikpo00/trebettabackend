// src/models/PoolPayout.js
const pool = require('../config/db');

async function create(payout) {
  const { pool_id, entry_id, user_id, amount, status, provider_reference } = payout;
  const [res] = await pool.query(
    `INSERT INTO pool_payouts (pool_id, entry_id, user_id, amount, status, provider_reference, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())`,
    [pool_id, entry_id, user_id, amount, status || 'pending', provider_reference || null]
  );
  return res.insertId;
}

async function updateStatus(id, status, opts = {}) {
  const { provider_reference, last_error } = opts;
  await pool.query('UPDATE pool_payouts SET status = ?, provider_reference = ?, last_error = ?, updated_at = NOW() WHERE id = ?', [status, provider_reference || null, last_error || null, id]);
}

async function listByPool(poolId) {
  const [rows] = await pool.query('SELECT * FROM pool_payouts WHERE pool_id = ? ORDER BY created_at', [poolId]);
  return rows;
}

module.exports = { create, updateStatus, listByPool };
