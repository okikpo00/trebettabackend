// utils/sendNotification.js
const pool = require('../config/db');

/**
 * Send notification (DB + socket)
 * @param {Number} userId 
 * @param {String} title 
 * @param {String} message 
 * @param {String} type - success | info | warning | error
 * @param {Object} io - optional socket instance
 */
const sendNotification = async (userId, title, message, type = 'info', io = null) => {
  try {
    await pool.query(
      'INSERT INTO notifications (user_id, title, message, type, created_at) VALUES (?, ?, ?, ?, NOW())',
      [userId, title, message, type]
    );

    if (io) {
      io.to(`user_${userId}`).emit('notification', { title, message, type });
    }
  } catch (error) {
    console.error('Error sending notification:', error.message);
  }
};

module.exports = sendNotification;
