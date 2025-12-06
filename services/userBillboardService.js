const pool = require('../config/db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const BILLBOARD_CACHE_KEY = 'home:billboards';
const BILLBOARD_CACHE_TTL = 600; // seconds

async function getActiveBillboards() {
  try {
    // ✅ Try cache first
    const cached = await cache.get(BILLBOARD_CACHE_KEY);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    logger.warn('Cache read failed for billboards', e);
  }

  const [rows] = await pool.query(
    `SELECT id, title, image_url, video_url, redirect_link, description 
     FROM billboards 
     WHERE is_active = 1 
     ORDER BY created_at DESC 
     LIMIT 20`
  );

  try {
    await cache.set(BILLBOARD_CACHE_KEY, JSON.stringify(rows), BILLBOARD_CACHE_TTL);
  } catch (e) {
    logger.warn('Cache set failed for billboards', e);
  }

  return rows;
}

module.exports = { getActiveBillboards };
