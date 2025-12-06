// middlewares/requireAdmin.js
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { touchAdminSession } = require('../services/adminSessionService');

const ADMIN_JWT_SECRET =
  process.env.ADMIN_JWT_SECRET ||
  process.env.JWT_SECRET ||
  'change_this_admin_secret';

module.exports = async function requireAdmin(req, res, next) {
  try {
    // ---------------------------------------------
    // 1. CHECK BEARER TOKEN
    // ---------------------------------------------
    const auth = req.headers.authorization || '';
    const parts = auth.split(' ');

    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const token = parts[1];
    let payload;

    try {
      payload = jwt.verify(token, ADMIN_JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ message: 'Invalid token' });
    }

    // ---------------------------------------------
    // 2. VERIFY USER EXISTS + IS ADMIN
    // ---------------------------------------------
    const [rows] = await pool.query(
      'SELECT id, role, status FROM users WHERE id = ? LIMIT 1',
      [payload.id]
    );

    if (!rows.length) return res.status(401).json({ message: 'Unauthorized' });

    const user = rows[0];
    if (user.role !== 'admin')
      return res.status(403).json({ message: 'Forbidden' });

    if (['deleted', 'frozen'].includes(user.status))
      return res.status(403).json({ message: 'Account not allowed' });

    // Attach admin user id
    req.user = { id: user.id, role: user.role };

    // ---------------------------------------------
    // 3. VERIFY ADMIN SESSION (NEW)
    // ---------------------------------------------
    const sessionId = Number(req.headers['x-admin-session-id']);

    if (!sessionId) {
      return res
        .status(401)
        .json({ message: 'Admin session ID missing (x-admin-session-id)' });
    }

    const [sess] = await pool.query(
      `SELECT id, admin_id, is_current FROM admin_sessions
       WHERE id = ? LIMIT 1`,
      [sessionId]
    );

    if (!sess.length) {
      return res
        .status(401)
        .json({ message: 'Admin session not found or expired' });
    }

    const session = sess[0];

    if (session.admin_id !== user.id) {
      return res.status(403).json({
        message: 'Session does not belong to this admin'
      });
    }

    if (!session.is_current) {
      return res.status(403).json({
        message: 'This session was terminated — please login again'
      });
    }

    // Attach current session to request (for kill endpoints)
    req.adminSessionId = sessionId;

    // ---------------------------------------------
    // 4. UPDATE last_active
    // ---------------------------------------------
    touchAdminSession(sessionId).catch(() => {});

    return next();
  } catch (err) {
    console.error('requireAdmin err', err);
    return res.status(500).json({ message: 'Server error' });
  }
};
