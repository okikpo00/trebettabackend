// utils/auditLog.js
const pool = require('../config/db');

// auditLog(adminId, userId, action, entity, entityId, details)
async function auditLog(adminId, userId, action, entity, entityId, details) {
  try {
    const q = `INSERT INTO audit_log (user_id, admin_id, action, entity, entity_id, details, created_at)
               VALUES (?, ?, ?, ?, ?, ?, NOW())`;
    const params = [userId || null, adminId || null, action, entity, entityId || null, JSON.stringify(details || {})];
    await pool.query(q, params);
  } catch (err) {
    console.warn('auditLog failed', err.message);
  }
}

module.exports = { auditLog };
