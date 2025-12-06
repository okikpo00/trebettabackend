// controllers/_adminHelpers.js
const pool = require('../config/db');

async function auditLog(conn, adminId, action, entity, entityId, details) {
  // if conn passed, use conn.execute; otherwise use pool.query
  const q = `INSERT INTO audit_log (user_id, admin_id, action, entity, entity_id, details, created_at)
             VALUES (?, ?, ?, ?, ?, ?, NOW())`;
  const params = [null, adminId || null, action, entity, entityId || null, JSON.stringify(details || {})];
  if (conn) {
    await conn.query(q, params);
  } else {
    await pool.query(q, params);
  }
}

async function createTransactionRecord(conn, { user_id, wallet_id, type, amount, balance_before, balance_after, reference, recipient_id = null, description = null, reason = null, metadata = null, admin_id = null, status = 'completed' }) {
  const insertSql = `
    INSERT INTO transactions
      (user_id, wallet_id, type, amount, balance_before, balance_after, reference, recipient_id, description, reason, metadata, admin_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
  `;
  const params = [user_id, wallet_id, type, amount, balance_before, balance_after, reference, recipient_id, description, reason, metadata ? JSON.stringify(metadata) : null, admin_id, status];
  // use conn.execute to get insertId if conn present
  if (conn) {
    const [result] = await conn.query(insertSql, params);
    return result.insertId;
  } else {
    const [result] = await pool.query(insertSql, params);
    return result.insertId;
  }
}



async function checkWithdrawalLimit(user_id, amount) {
  // Get user's KYC level
  const [userRows] = await pool.query(`SELECT kyc_level FROM users WHERE id = ?`, [user_id]);
  if (!userRows.length) throw new Error('User not found');

  const kyc_level = userRows[0].kyc_level;

  // Get limit
  const [limitRows] = await pool.query(
    `SELECT daily_limit, monthly_limit FROM withdrawal_limits WHERE kyc_level = ?`,
    [kyc_level]
  );
  const limit = limitRows[0];

  if (!limit || limit.daily_limit === null) return true; // advanced — no limit

  // Calculate total withdrawals today
  const [todayRows] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_today
     FROM transactions
     WHERE user_id = ? AND type = 'withdrawal' AND status = 'completed'
     AND DATE(created_at) = CURDATE()`,
    [user_id]
  );

  // Calculate total this month
  const [monthRows] = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_month
     FROM transactions
     WHERE user_id = ? AND type = 'withdrawal' AND status = 'completed'
     AND MONTH(created_at) = MONTH(CURDATE()) AND YEAR(created_at) = YEAR(CURDATE())`,
    [user_id]
  );

  const totalToday = todayRows[0].total_today;
  const totalMonth = monthRows[0].total_month;

  if (totalToday + amount > limit.daily_limit)
    throw new Error(`Daily limit reached (₦${limit.daily_limit})`);

  if (totalMonth + amount > limit.monthly_limit)
    throw new Error(`Monthly limit reached (₦${limit.monthly_limit})`);

  return true;
}




module.exports = { auditLog, createTransactionRecord, checkWithdrawalLimit };
