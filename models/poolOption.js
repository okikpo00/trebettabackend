// src/models/PoolOption.js
const pool = require('../config/db');

async function create(poolId, title, metadata = null) {
  const [res] = await pool.query('INSERT INTO pool_options (pool_id, title, metadata, created_at) VALUES (?, ?, ?, NOW())', [poolId, title, metadata ? JSON.stringify(metadata) : null]);
  return res.insertId;
}

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM pool_options WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function update(id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const params = keys.map(k => data[k]);
  params.push(id);
  await pool.query(`UPDATE pool_options SET ${sets}, updated_at = NOW() WHERE id = ?`, params);
}

async function listByPool(poolId) {
  const [rows] = await pool.query('SELECT * FROM pool_options WHERE pool_id = ? ORDER BY id', [poolId]);
  return rows;
}

module.exports = { create, findById, update, listByPool };
