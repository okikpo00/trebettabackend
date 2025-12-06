// controllers/adminUserController.js
const pool = require('../config/db');
const { auditLog } = require('../utils/auditLog');
const notify = require("../utils/notify");
const crypto = require('crypto');
const XLSX = require('xlsx');


// ✅ GET /api/admin/users
exports.getUsers = async (req, res) => {
  try {
    const { page = 1, limit = 20, search, kyc_status, kyc_level, status, date_from, date_to } = req.query;
    const offset = (page - 1) * limit;

    let where = 'WHERE 1=1';
    const params = [];

    if (search) {
      where += ` AND (u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR u.username LIKE ? OR u.phone LIKE ?)`;
      const s = `%${search}%`;
      params.push(s, s, s, s, s);
    }
    if (kyc_status) { where += ' AND u.kyc_status = ?'; params.push(kyc_status); }
    if (kyc_level) { where += ' AND u.kyc_level = ?'; params.push(kyc_level); }
    if (status) { where += ' AND u.status = ?'; params.push(status); }
    if (date_from && date_to) { where += ' AND u.created_at BETWEEN ? AND ?'; params.push(date_from, date_to); }

    const [rows] = await pool.query(
      `SELECT u.id, u.username, u.first_name, u.last_name, u.email, u.phone,
              u.status, u.kyc_status, u.kyc_level, u.role, u.created_at,
              w.balance, w.currency
       FROM users u
       LEFT JOIN wallets w ON u.id = w.user_id
       ${where}
       ORDER BY u.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) as total FROM users u ${where}`,
      params
    );

    res.json({ status: true, total, page: Number(page), limit: Number(limit), data: rows });
  } catch (err) {
    console.error('getUsers err', err);
    res.status(500).json({ status: false, message: 'Server error', error: err.message });
  }
};


// ✅ GET /api/admin/users/:id
exports.getUserDetails = async (req, res) => {
  try {
    const userId = req.params.id;

    const [[user]] = await pool.query(
      `SELECT u.*, w.balance, w.currency
       FROM users u
       LEFT JOIN wallets w ON u.id = w.user_id
       WHERE u.id = ? LIMIT 1`,
      [userId]
    );

    if (!user) return res.status(404).json({ message: 'User not found' });

    const [transactions] = await pool.query(
      `SELECT id, type, amount, status, created_at
       FROM transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );

    const [kyc] = await pool.query(
      `SELECT * FROM kyc_verificationss WHERE user_id = ? LIMIT 1`,
      [userId]
    );

    const [audit] = await pool.query(
      `SELECT action, entity, created_at, details
       FROM audit_log
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 20`,
      [userId]
    );

    res.json({
      status: true,
      user,
      wallet: { balance: user.balance, currency: user.currency },
      kyc: kyc[0] || null,
      transactions,
      audit,
    });
  } catch (err) {
    console.error('getUserDetails err', err);
    res.status(500).json({ status: false, message: 'Server error', error: err.message });
  }
};


// ✅ PATCH /api/admin/users/:id/status
exports.updateUserStatus = async (req, res) => {
  try {
    const userId = req.params.id;
    const { action } = req.body;
    const adminId = req.user?.id;

    if (!['suspend', 'unsuspend'].includes(action))
      return res.status(400).json({ message: 'Invalid action' });

    const newStatus = action === 'suspend' ? 'suspended' : 'active';
    await pool.query('UPDATE users SET status = ?, updated_at = NOW() WHERE id = ?', [newStatus, userId]);

    await auditLog(adminId, userId, 'UPDATE_USER_STATUS', 'user', userId, { newStatus });

    const msg = newStatus === 'suspended'
      ? 'Your account has been suspended by Trebetta Admin.'
      : 'Your account has been reactivated. You can now continue using Trebetta.';

    await notify(userId, 'Account Status Update', msg);
    await notify(userId, 'Trebetta Account Status Update', `<p>${msg}</p>`);

    res.json({ status: true, message: `User ${action}ed successfully` });
  } catch (err) {
    console.error('updateUserStatus err', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};


// ✅ PATCH /api/admin/users/:id/reset-password
exports.resetUserPassword = async (req, res) => {
  try {
    const userId = req.params.id;
    const adminId = req.user?.id;

    const [[user]] = await pool.query('SELECT id, email, first_name FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const resetToken = crypto.randomBytes(24).toString('hex');
    const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;

    await notify(
      user.email,
      'Trebetta Password Reset',
      `<p>Hello ${user.first_name || 'User'},</p>
       <p>Click below to reset your Trebetta password:</p>
       <a href="${resetLink}">${resetLink}</a>`
    );

    await auditLog(adminId, userId, 'ADMIN_RESET_PASSWORD', 'user', userId, { via: 'email' });

    res.json({ status: true, message: 'Password reset link sent to user email.' });
  } catch (err) {
    console.error('resetUserPassword err', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};


// ========================
// EXPORT USERS TO XLSX
// ========================

exports.exportUsers = async (req, res) => {
  const { status, kyc_status, date_from, date_to } = req.query;

  let sql = `SELECT u.id, u.username, u.email, u.phone, u.status, w.balance, u.kyc_status, u.created_at 
             FROM users u 
             LEFT JOIN wallets w ON u.id = w.user_id 
             WHERE 1=1`;
  const params = [];

  if (status) {
    sql += " AND u.status = ?";
    params.push(status);
  }
  if (kyc_status) {
    sql += " AND u.kyc_status = ?";
    params.push(kyc_status);
  }
  if (date_from && date_to) {
    sql += " AND DATE(u.created_at) BETWEEN ? AND ?";
    params.push(date_from, date_to);
  }

  try {
    const [users] = await pool.query(sql, params);

    // Convert users (array of objects) to worksheet
    const ws = XLSX.utils.json_to_sheet(users);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Users");

    const wbOpts = { bookType: "xlsx", type: "buffer" };
    const buf = XLSX.write(wb, wbOpts);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=users_export.xlsx"
    );
    res.send(buf);
  } catch (err) {
    console.error("exportUsers (xlsx) error:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
};




// ✅ PATCH /api/admin/users/:id/kyc
exports.updateUserKYC = async (req, res) => {
  try {
    const userId = req.params.id;
    const adminId = req.user?.id;
    const { action, note } = req.body;

    if (!['approve', 'reject'].includes(action))
      return res.status(400).json({ message: 'Invalid action' });

    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    await pool.query(
      'UPDATE users SET kyc_status = ?, kyc_reviewed_by = ?, kyc_reviewed_at = NOW(), updated_at = NOW() WHERE id = ?',
      [newStatus, adminId, userId]
    );

    await auditLog(adminId, userId, 'UPDATE_USER_KYC', 'user', userId, { action, note });

    const msg =
      newStatus === 'approved'
        ? 'Your KYC has been approved. You now have full access to Trebetta features.'
        : `Your KYC has been rejected. ${note ? 'Reason: ' + note : ''}`;

    await notify(userId, 'KYC Update', msg);
    await notify(userId, 'Trebetta KYC Update', `<p>${msg}</p>`);

    res.json({ status: true, message: `User KYC ${newStatus}` });
  } catch (err) {
    console.error('updateUserKYC err', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};


// ✅ DELETE /api/admin/users/:id
exports.deleteUser = async (req, res) => {
  try {
    const userId = req.params.id;
    const adminId = req.user?.id;
    const { reason } = req.body || {};

    await pool.query(
      'UPDATE users SET status = "blocked", updated_at = NOW() WHERE id = ?',
      [userId]
    );

    await auditLog(adminId, userId, 'ADMIN_DELETE_USER', 'user', userId, { reason });

    await notify(userId, 'Account Deactivated', 'Your Trebetta account has been deactivated by admin.');
    await notify(userId, 'Trebetta Account Deactivated', `<p>Your Trebetta account has been deactivated.</p>`);

    res.json({ status: true, message: 'User account blocked (soft deleted).' });
  } catch (err) {
    console.error('deleteUser err', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
