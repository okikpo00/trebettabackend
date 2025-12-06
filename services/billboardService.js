const pool = require('../config/db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const BILLBOARD_CACHE_KEY = 'home:billboards';
const BILLBOARD_CACHE_TTL = 600; // seconds

async function createBillboard({
  title,
  image_url = null,
  video_url = null,
  redirect_link = null,
  description = null,
  is_active = true,
}) {
  const [result] = await pool.query(
    `INSERT INTO billboards (title, image_url, video_url, redirect_link, description, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [title, image_url, video_url, redirect_link, description, is_active ? 1 : 0]
  );

  try {
    await cache.del(BILLBOARD_CACHE_KEY);
  } catch (e) {
    logger.warn('cache.del error', e);
  }

  return { id: result.insertId };
}

async function updateBillboard(id, updates = {}) {
  const fields = [];
  const params = [];

  if (updates.title !== undefined) { fields.push('title = ?'); params.push(updates.title); }
  if (updates.image_url !== undefined) { fields.push('image_url = ?'); params.push(updates.image_url); }
  if (updates.video_url !== undefined) { fields.push('video_url = ?'); params.push(updates.video_url); }
  if (updates.redirect_link !== undefined) { fields.push('redirect_link = ?'); params.push(updates.redirect_link); }
  if (updates.description !== undefined) { fields.push('description = ?'); params.push(updates.description); }
  if (updates.is_active !== undefined) { fields.push('is_active = ?'); params.push(updates.is_active ? 1 : 0); }

  if (fields.length === 0) return { changed: 0 };

  const sql = `UPDATE billboards SET ${fields.join(', ')}, updated_at = NOW() WHERE id = ?`;
  params.push(id);

  const [result] = await pool.query(sql, params);

  try {
    await cache.del(BILLBOARD_CACHE_KEY);
  } catch (e) {
    logger.warn('cache.del error', e);
  }

  return { changed: result.affectedRows };
}

async function deleteBillboard(id) {
  const [result] = await pool.query('DELETE FROM billboards WHERE id = ?', [id]);
  try {
    await cache.del(BILLBOARD_CACHE_KEY);
  } catch (e) {
    logger.warn('cache.del error', e);
  }
  return { deleted: result.affectedRows };
}

async function listBillboards({ onlyActive = false } = {}) {
  if (onlyActive) {
    try {
      const cached = await cache.get(BILLBOARD_CACHE_KEY);
      if (cached) return JSON.parse(cached);
    } catch (e) {
      logger.warn('cache.get failed for billboards', e);
    }
  }

  let sql = 'SELECT id, title, image_url, video_url, redirect_link, description, is_active, created_at, updated_at FROM billboards';
  if (onlyActive) sql += ' WHERE is_active = 1';
  sql += ' ORDER BY created_at DESC LIMIT 50';

  const [rows] = await pool.query(sql);

  if (onlyActive) {
    try {
      await cache.set(BILLBOARD_CACHE_KEY, JSON.stringify(rows), BILLBOARD_CACHE_TTL);
    } catch (e) {
      logger.warn('cache.set failed for billboards', e);
    }
  }

  return rows;
}

module.exports = {
  createBillboard,
  updateBillboard,
  deleteBillboard,
  listBillboards,
};
