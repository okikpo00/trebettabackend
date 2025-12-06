// controllers/adminSessionController.js
const pool = require('../config/db');
const { auditLog } = require('../utils/auditLog');
const logger = require('../utils/logger');

/**
 * GET /api/admin/sessions
 * List sessions for current admin
 */
exports.listSessions = async (req, res) => {
  const adminId = req.user?.id;
  console.log('adminSessionController.listSessions › adminId:', adminId);

  try {
    const [rows] = await pool.query(
      `SELECT id, ip_address, user_agent, is_current, created_at, last_active
       FROM admin_sessions
       WHERE admin_id = ?
       ORDER BY created_at DESC`,
      [adminId]
    );

    return res.json({ status: true, data: rows });
  } catch (err) {
    logger.error('adminSessionController.listSessions err', err);
    return res
      .status(500)
      .json({ status: false, message: 'Failed to load sessions', error: err.message });
  }
};

/**
 * POST /api/admin/sessions/:id/kill
 */
exports.killSession = async (req, res) => {
  const adminId = req.user?.id;
  const sessionId = Number(req.params.id);
  const currentSessionId = req.adminSessionId || null; // expected to be set in middleware later

  console.log('adminSessionController.killSession ›', {
    adminId,
    sessionId,
    currentSessionId
  });

  if (!sessionId) {
    return res
      .status(400)
      .json({ status: false, message: 'Invalid session id' });
  }

  try {
    if (currentSessionId && sessionId === currentSessionId) {
      return res
        .status(400)
        .json({ status: false, message: 'Cannot kill current active session' });
    }

    const [rows] = await pool.query(
      `SELECT * FROM admin_sessions WHERE id = ? AND admin_id = ? LIMIT 1`,
      [sessionId, adminId]
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ status: false, message: 'Session not found' });
    }

    await pool.query(
      `DELETE FROM admin_sessions WHERE id = ? AND admin_id = ?`,
      [sessionId, adminId]
    );

    try {
      await auditLog(
        null,
        adminId,
        'ADMIN_SESSION_KILLED',
        'admin_session',
        sessionId,
        {}
      );
    } catch (aErr) {
      logger.warn('adminSessionController.killSession › auditLog failed', aErr);
    }

    return res.json({ status: true, message: 'Session terminated' });
  } catch (err) {
    logger.error('adminSessionController.killSession err', err);
    return res
      .status(500)
      .json({ status: false, message: 'Failed to terminate session', error: err.message });
  }
};

/**
 * POST /api/admin/sessions/kill-others
 */
exports.killOtherSessions = async (req, res) => {
  const adminId = req.user?.id;
  const currentSessionId = req.adminSessionId || null;

  console.log('adminSessionController.killOtherSessions ›', {
    adminId,
    currentSessionId
  });

  try {
    if (currentSessionId) {
      await pool.query(
        `DELETE FROM admin_sessions WHERE admin_id = ? AND id <> ?`,
        [adminId, currentSessionId]
      );
    } else {
      // If we don't know current session, be safe and don't delete all
      await pool.query(
        `DELETE FROM admin_sessions WHERE admin_id = ?`,
        [adminId]
      );
    }

    try {
      await auditLog(
        null,
        adminId,
        'ADMIN_SESSIONS_KILLED_OTHERS',
        'admin_session',
        null,
        { keep_current: !!currentSessionId }
      );
    } catch (aErr) {
      logger.warn('adminSessionController.killOtherSessions › auditLog failed', aErr);
    }

    return res.json({
      status: true,
      message: 'Other sessions terminated'
    });
  } catch (err) {
    logger.error('adminSessionController.killOtherSessions err', err);
    return res
      .status(500)
      .json({ status: false, message: 'Failed to terminate other sessions', error: err.message });
  }
};
