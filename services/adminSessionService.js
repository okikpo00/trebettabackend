// services/adminSessionService.js
const pool = require('../config/db');
const logger = require('../utils/logger');

/**
 * Create new admin session on successful login.
 * Returns inserted id.
 */
async function createAdminSession(adminId, ip, userAgent) {
  console.log('adminSessionService.createAdminSession ›', { adminId, ip });

  const [result] = await pool.query(
    `INSERT INTO admin_sessions
     (admin_id, ip_address, user_agent, is_current, created_at, last_active)
     VALUES (?, ?, ?, 1, NOW(), NOW())`,
    [adminId, ip || null, userAgent || null]
  );

  return result.insertId;
}

/**
 * Mark this session as active (call on each authed request).
 */
async function touchAdminSession(sessionId) {
  if (!sessionId) return;
  try {
    await pool.query(
      `UPDATE admin_sessions 
       SET last_active = NOW() 
       WHERE id = ?`,
      [sessionId]
    );
  } catch (err) {
    logger.warn('adminSessionService.touchAdminSession err', err);
  }
}

module.exports = {
  createAdminSession,
  touchAdminSession
};
