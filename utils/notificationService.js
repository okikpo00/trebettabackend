// utils/notificationService.js
const pool = require('../config/db');
const sendEmail = require('./sendEmail') || require('../utils/sendEmail'); // adjust if your mailer file name
// insert notification into notifications table (in-app)
async function sendInApp(userId, title, message, meta = {}) {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, title, message, type, metadata, status, created_at) VALUES (?, ?, ?, ?, ?, 'unread', NOW())`,
      [userId, title, message, meta.type || 'system', JSON.stringify(meta || {})]
    );
  } catch (err) {
    console.error('sendInApp err', err);
  }
}

async function sendNotification(userId, title, messageOrMeta = {}, meta = {}) {
  const message = typeof messageOrMeta === 'string' ? messageOrMeta : (messageOrMeta.message || '');
  const m = typeof messageOrMeta === 'object' && !Array.isArray(messageOrMeta) ? { ...messageOrMeta, ...meta } : meta;
  // Insert in-app
  await sendInApp(userId, title, message, m);
  // Send email if user's email exists
  try {
    const [rows] = await pool.query('SELECT email FROM users WHERE id = ? LIMIT 1', [userId]);
    if (rows && rows[0] && rows[0].email) {
      // light email content
      const html = `<p>${title}</p><p>${message}</p>`;
      await sendEmail(rows[0].email, title, html).catch(e => console.error('sendEmail err', e));
    }
  } catch (e) {
    console.error('sendNotification lookup err', e);
  }
}

module.exports = { sendNotification, sendInApp };
