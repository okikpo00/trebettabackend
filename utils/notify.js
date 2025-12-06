// utils/notify.js
const sendEmail = require("./sendEmail");
const sendNotification = require("./sendNotification");


/**
 * Central unified notifier
 * @param {object} params
 *   {number} userId
 *   {string} title
 *   {string} message
 *   {string[]} channels - ["inApp", "email"]
 *   {string} [email]
 
 *   {string} [type] - info | success | warning | error
 */
async function notify({ userId, title, message, channels = ["inApp"], email, fcmToken, type = "info" }) {
  try {
    if (channels.includes("inApp") && userId) {
      await sendNotification(userId, title, message, type);
    }


    if (channels.includes("email") && email) {
      await sendEmail(email, title, `<p>${message}</p>`);
    }

    console.log(`✅ Notification sent [${channels.join(", ")}] → ${title}`);
  } catch (err) {
    console.error("❌ notify.js error:", err.message);
  }
}

module.exports = notify;
