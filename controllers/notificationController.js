const pool = require('../config/db');

/**
 * ---------------------------------------------------------
 * GET USER NOTIFICATIONS (Paginated)
 * GET /notifications
 * Query:
 *  - page (default 1)
 *  - limit (default 20, max 50)
 * ---------------------------------------------------------
 */
async function getNotifications(req, res) {
  const userId = req.user.id;

  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  try {
    const [[countRow]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM notifications
       WHERE user_id = ?`,
      [userId]
    );

    const total = Number(countRow.total || 0);

    const [rows] = await pool.query(
      `SELECT
         id,
         title,
         message,
         type,
         severity,
         is_read,
         metadata,
         created_at
       FROM notifications
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [userId, limit, offset]
    );

    const data = rows.map(n => {
      let metadata = null;
      try {
        metadata = n.metadata ? JSON.parse(n.metadata) : null;
      } catch {
        metadata = null;
      }

      return {
        id: n.id,
        title: n.title,
        message: n.message,
        type: n.type,
        severity: n.severity,
        is_read: Boolean(n.is_read),
        metadata,
        created_at: n.created_at
      };
    });

    return res.json({
      status: true,
      data,
      pagination: {
        page,
        limit,
        total,
        page_count: Math.ceil(total / limit)
      }
    });

  } catch (err) {
    console.error('[NOTIFICATION] getNotifications error:', err);
    return res.status(500).json({
      status: false,
      message: 'Failed to load notifications'
    });
  }
}

/**
 * ---------------------------------------------------------
 * GET UNREAD COUNT
 * GET /notifications/unread-count
 * ---------------------------------------------------------
 */
async function getUnreadCount(req, res) {
  const userId = req.user.id;

  try {
    const [[row]] = await pool.query(
      `SELECT COUNT(*) AS unread
       FROM notifications
       WHERE user_id = ? AND is_read = 0`,
      [userId]
    );

    return res.json({
      status: true,
      unread: Number(row.unread || 0)
    });

  } catch (err) {
    console.error('[NOTIFICATION] getUnreadCount error:', err);
    return res.status(500).json({
      status: false,
      message: 'Failed to load unread count'
    });
  }
}

/**
 * ---------------------------------------------------------
 * MARK ONE NOTIFICATION AS READ
 * PATCH /notifications/:id/read
 * ---------------------------------------------------------
 */
async function markAsRead(req, res) {
  const userId = req.user.id;
  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({
      status: false,
      message: 'Invalid notification id'
    });
  }

  try {
    const [result] = await pool.query(
      `UPDATE notifications
       SET is_read = 1
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [id, userId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        status: false,
        message: 'Notification not found'
      });
    }

    return res.json({
      status: true,
      message: 'Notification marked as read'
    });

  } catch (err) {
    console.error('[NOTIFICATION] markAsRead error:', err);
    return res.status(500).json({
      status: false,
      message: 'Failed to update notification'
    });
  }
}

/**
 * ---------------------------------------------------------
 * MARK ALL AS READ
 * PATCH /notifications/read-all
 * ---------------------------------------------------------
 */
async function markAllAsRead(req, res) {
  const userId = req.user.id;

  try {
    await pool.query(
      `UPDATE notifications
       SET is_read = 1
       WHERE user_id = ? AND is_read = 0`,
      [userId]
    );

    return res.json({
      status: true,
      message: 'All notifications marked as read'
    });

  } catch (err) {
    console.error('[NOTIFICATION] markAllAsRead error:', err);
    return res.status(500).json({
      status: false,
      message: 'Failed to update notifications'
    });
  }
}

/**
 * ---------------------------------------------------------
 * DELETE NOTIFICATION (optional UX)
 * DELETE /notifications/:id
 * ---------------------------------------------------------
 */
async function deleteNotification(req, res) {
  const userId = req.user.id;
  const id = Number(req.params.id);

  try {
    const [result] = await pool.query(
      `DELETE FROM notifications
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [id, userId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({
        status: false,
        message: 'Notification not found'
      });
    }

    return res.json({
      status: true,
      message: 'Notification deleted'
    });

  } catch (err) {
    console.error('[NOTIFICATION] deleteNotification error:', err);
    return res.status(500).json({
      status: false,
      message: 'Failed to delete notification'
    });
  }
}

module.exports = {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification
};
