const pool = require('../config/db');
const sendEmail = require('./sendEmail');

/**
 * CENTRAL NOTIFICATION ENGINE
 *
 * RULES:
 * - Always save notification to DB
 * - Always attempt email
 * - Never crash the main request
 *
 * @param {Object} params
 * @param {number} params.userId        (REQUIRED)
 * @param {string} params.title         (REQUIRED)
 * @param {string} params.message       (REQUIRED)
 * @param {string} params.type          deposit | withdrawal | wallet | security | system
 * @param {string} params.severity      info | success | warning | error
 * @param {string} params.email         (REQUIRED for now)
 * @param {Object} params.metadata      (optional)
 */
async function notify({
  userId,
  title,
  message,
  type,
  severity = 'info',
  email,
  metadata = null
}) {
  if (!userId || !title || !message || !type) {
    console.error('❌ notify.js missing required fields');
    return;
  }

  // 1️⃣ Save in-app notification (NON-NEGOTIABLE)
  try {
    await pool.query(
      `
      INSERT INTO notifications
        (user_id, title, message, type, severity, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        userId,
        title,
        message,
        type,
        severity,
        metadata ? JSON.stringify(metadata) : null
      ]
    );
  } catch (dbErr) {
    console.error('❌ notify.js DB insert failed:', dbErr.message);
  }

  // 2️⃣ Send email (MANDATORY, best-effort)
  if (email) {
    try {
      await sendEmail(
        email,
        title,
        `
          <div style="font-family: Arial, sans-serif;">
            <h3>${title}</h3>
            <p>${message}</p>
            <p style="font-size:12px;color:#666;">
              If this wasn’t you, please contact Trebetta support immediately.
            </p>
          </div>
        `
      );
    } catch (emailErr) {
      console.error('❌ notify.js email failed:', emailErr.message);
    }
  } else {
    console.warn('⚠️ notify.js email missing for user:', userId);
  }
}

module.exports = notify;
