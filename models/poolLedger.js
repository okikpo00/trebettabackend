// src/models/PoolLedger.js
const pool = require('../config/db');

async function create(ledger) {
  const { pool_id, total_pool, company_cut, payout_pool, total_winners, total_payouts, details } = ledger;
  const [res] = await pool.query(
    `INSERT INTO pool_ledger (pool_id, total_pool, company_cut, payout_pool, total_winners, total_payouts, details, settled_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [pool_id, total_pool, company_cut, payout_pool, total_winners || 0, total_payouts || 0, details ? JSON.stringify(details) : null]
  );
  return res.insertId;
}

async function findByPool(poolId) {
  const [rows] = await pool.query('SELECT * FROM pool_ledger WHERE pool_id = ? LIMIT 1', [poolId]);
  return rows[0] || null;
}

module.exports = { create, findByPool };
