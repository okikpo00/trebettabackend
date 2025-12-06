// src/models/Pool.js
const pool = require('../config/db');

async function findById(id) {
  const [rows] = await pool.query('SELECT * FROM pools WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function create(data) {
  const { title, type, description, min_entry, closing_date, created_by, metadata } = data;
  const [res] = await pool.query(
    `INSERT INTO pools (title, type, description, min_entry, closing_date, created_by, status, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NOW())`,
    [title, type, description || null, min_entry, closing_date || null, created_by || null, metadata ? JSON.stringify(metadata) : null]
  );
  return res.insertId;
}

async function update(id, data) {
  // safe update: build SET dynamically
  const keys = Object.keys(data);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const params = keys.map(k => data[k]);
  params.push(id);
  await pool.query(`UPDATE pools SET ${sets}, updated_at = NOW() WHERE id = ?`, params);
}

async function list({ type, status, page = 1, limit = 20, search } = {}) {
  const offset = (page - 1) * limit;
  const where = [];
  const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (search) { where.push('(title LIKE ?)'); params.push(`%${search}%`); }
  const whereSQL = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const [rows] = await pool.query(`SELECT * FROM pools ${whereSQL} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, Number(limit), Number(offset)]);
  return rows;
}

module.exports = { findById, create, update, list };
