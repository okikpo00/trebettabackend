// controllers/notificationController.js
const pool = require('../config/db');
const sendEmail  = require('../utils/mailer'); 
// admin: create notification (broadcast if user_id omitted)
exports.createNotification = async (req, res) => {
  const { user_id, type, title, message, data } = req.body || {};
  try {
    const [r] = await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, data) VALUES (?, ?, ?, ?, ?)`,
      [user_id || null, type || null, title, message, data ? JSON.stringify(data) : null]
    );

    // if broadcast (user_id null), you may want to insert notification_recipients rows or use push service
    res.status(201).json({ message: 'Notification created', id: r.insertId });
  } catch (err) {
    console.error('createNotification err', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// user: get notifications for self
exports.myNotifications = async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [req.user.id]);
    res.json(rows);
  } catch (err) {
    console.error('myNotifications err', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// admin: send notification (broadcast if user_id omitted)
exports.sendNotification = async (req, res) => {
  const { user_id, title, message } = req.body;

  if (!user_id || !title || !message) {
    return res.status(400).json({ message: 'user_id, title, and message required' });
  }

  try {
    // get user email
    const [rows] = await pool.query('SELECT email FROM users WHERE id = ? LIMIT 1', [user_id]);
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    const user = rows[0];

    // send email
    await sendEmail(user.email, title, message);

    // save notification record
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, ?)',
      [user_id, title, message, 'email']
    );

    res.json({ message: 'Notification sent successfully', user_id });
  } catch (err) {
    console.error('sendNotification err', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
