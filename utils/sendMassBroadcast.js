// utils/sendMassBroadcast.js
const pool = require("../config/db");
const sendNotification = require("./sendNotification");
const sendPush = require("./sendPush");
const sendEmail = require("./sendEmail");

/**
 * Send message to all active users
 * @param {string} title
 * @param {string} message
 * @param {object} options
 *   {boolean} push - send push notifications
 *   {boolean} email - send emails
 *   {boolean} inApp - create DB notification
 */
async function sendMassBroadcast(title, message, options = { push: true, email: false, inApp: true }) {
  try {
    const [users] = await pool.query("SELECT id, email, fcm_token FROM users WHERE status = 'active'");

    for (const user of users) {
      if (options.inApp) {
        await sendNotification(user.id, title, message, "info");
      }

      if (options.push && user.fcm_token) {
        await sendPush(user.fcm_token, title, message);
      }

      if (options.email && user.email) {
        await sendEmail(user.email, title, `<p>${message}</p>`);
      }
    }

    console.log(`📢 Broadcast sent to ${users.length} users`);
  } catch (error) {
    console.error("❌ Mass broadcast error:", error.message);
  }
}

module.exports = sendMassBroadcast;
