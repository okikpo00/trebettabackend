// utils/enforceWithdrawalLimits.js
const pool = require('../config/db');
const dayjs = require('dayjs');

/**
 * Check if user has exceeded withdrawal limits
 * @param {Number} userId 
 * @param {Number} amount 
 * @param {Object} limits - { dailyLimit, monthlyLimit }
 */
const enforceWithdrawalLimits = async (userId, amount, limits) => {
  const today = dayjs().format('YYYY-MM-DD');
  const monthStart = dayjs().startOf('month').format('YYYY-MM-DD');
  const monthEnd = dayjs().endOf('month').format('YYYY-MM-DD');

  // Daily total
  const [daily] = await pool.query(
    'SELECT SUM(amount) AS total FROM withdrawals WHERE user_id = ? AND DATE(created_at) = ? AND status IN ("pending", "completed")',
    [userId, today]
  );

  // Monthly total
  const [monthly] = await pool.query(
    'SELECT SUM(amount) AS total FROM withdrawals WHERE user_id = ? AND created_at BETWEEN ? AND ? AND status IN ("pending", "completed")',
    [userId, monthStart, monthEnd]
  );

  const dailyUsed = daily[0].total || 0;
  const monthlyUsed = monthly[0].total || 0;

  if (dailyUsed + amount > limits.dailyLimit) {
    throw new Error(`Daily withdrawal limit exceeded. Limit: ₦${limits.dailyLimit}`);
  }

  if (monthlyUsed + amount > limits.monthlyLimit) {
    throw new Error(`Monthly withdrawal limit exceeded. Limit: ₦${limits.monthlyLimit}`);
  }

  return true;
};

module.exports = enforceWithdrawalLimits;
