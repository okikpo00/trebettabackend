// controllers/adminProfileController.js
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const { auditLog } = require('../utils/auditLog');
const logger = require('../utils/logger');

/**
 * GET /api/admin/me
 */
exports.getMe = async (req, res) => {
  const adminId = req.user?.id;
  console.log('adminProfileController.getMe › adminId:', adminId);

  try {
    const [[row]] = await pool.query(
      `SELECT id, first_name, last_name, email, role, created_at, last_login
       FROM users
       WHERE id = ? AND role = 'admin'
       LIMIT 1`,
      [adminId]
    );

    if (!row) {
      return res
        .status(404)
        .json({ status: false, message: 'Admin not found' });
    }

    const name = [row.first_name, row.last_name].filter(Boolean).join(' ');

    return res.json({
      status: true,
      data: {
        id: row.id,
        name,
        email: row.email,
        role: row.role,
        created_at: row.created_at,
        last_login: row.last_login
      }
    });
  } catch (err) {
    logger.error('adminProfileController.getMe err', err);
    return res
      .status(500)
      .json({ status: false, message: 'Failed to fetch profile', error: err.message });
  }
};

/**
 * PUT /api/admin/me/update
 * body: { name, email }
 */
exports.updateMe = async (req, res) => {
  const adminId = req.user?.id;
  const { name, email } = req.body || {};
  console.log('adminProfileController.updateMe › adminId:', adminId, 'body:', req.body);

  try {
    if (!name && !email) {
      return res
        .status(400)
        .json({ status: false, message: 'Nothing to update' });
    }

    const [[current]] = await pool.query(
      `SELECT id, first_name, last_name, email
       FROM users
       WHERE id = ? AND role = 'admin'
       LIMIT 1`,
      [adminId]
    );

    if (!current) {
      return res
        .status(404)
        .json({ status: false, message: 'Admin not found' });
    }

    let firstName = current.first_name;
    let lastName = current.last_name;

    if (name) {
      const trimmed = String(name).trim();
      const parts = trimmed.split(' ');
      firstName = parts[0] || current.first_name;
      lastName = parts.slice(1).join(' ') || current.last_name;
    }

    let newEmail = current.email;
    if (email) {
      newEmail = String(email).trim().toLowerCase();
      if (!newEmail) {
        return res
          .status(400)
          .json({ status: false, message: 'Invalid email' });
      }

      // ensure unique email
      const [exists] = await pool.query(
        `SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1`,
        [newEmail, adminId]
      );
      if (exists.length) {
        return res
          .status(400)
          .json({ status: false, message: 'Email already in use' });
      }
    }

    await pool.query(
      `UPDATE users
       SET first_name = ?, last_name = ?, email = ?, updated_at = NOW()
       WHERE id = ? LIMIT 1`,
      [firstName, lastName, newEmail, adminId]
    );

    // audit
    try {
      await auditLog(
        null,
        adminId,
        'ADMIN_PROFILE_UPDATED',
        'user',
        adminId,
        {
          before: {
            first_name: current.first_name,
            last_name: current.last_name,
            email: current.email
          },
          after: {
            first_name: firstName,
            last_name: lastName,
            email: newEmail
          }
        }
      );
    } catch (aErr) {
      logger.warn('adminProfileController.updateMe › auditLog failed', aErr);
    }

    return res.json({
      status: true,
      message: 'Profile updated successfully'
    });
  } catch (err) {
    logger.error('adminProfileController.updateMe err', err);
    return res
      .status(500)
      .json({ status: false, message: 'Failed to update profile', error: err.message });
  }
};

/**
 * POST /api/admin/me/change-password
 * body: { old_password, new_password }
 */
exports.changePassword = async (req, res) => {
  const adminId = req.user?.id;
  const { old_password, new_password } = req.body || {};
  console.log('adminProfileController.changePassword › adminId:', adminId);

  try {
    if (!old_password || !new_password) {
      return res
        .status(400)
        .json({ status: false, message: 'Old and new password required' });
    }

    if (String(new_password).length < 6) {
      return res
        .status(400)
        .json({ status: false, message: 'New password must be at least 6 characters' });
    }

    const [[row]] = await pool.query(
      `SELECT password_hash FROM users WHERE id = ? AND role = 'admin' LIMIT 1`,
      [adminId]
    );

    if (!row) {
      return res
        .status(404)
        .json({ status: false, message: 'Admin not found' });
    }

    const ok = await bcrypt.compare(String(old_password), String(row.password_hash));
    if (!ok) {
      return res
        .status(400)
        .json({ status: false, message: 'Old password is incorrect' });
    }

    const newHash = await bcrypt.hash(String(new_password), 10);

    await pool.query(
      `UPDATE users SET password_hash = ?, updated_at = NOW() WHERE id = ? LIMIT 1`,
      [newHash, adminId]
    );

    try {
      await auditLog(
        null,
        adminId,
        'ADMIN_PASSWORD_CHANGED',
        'user',
        adminId,
        { message: 'Admin changed own password' }
      );
    } catch (aErr) {
      logger.warn('adminProfileController.changePassword › auditLog failed', aErr);
    }

    return res.json({
      status: true,
      message: 'Password changed successfully'
    });
  } catch (err) {
    logger.error('adminProfileController.changePassword err', err);
    return res
      .status(500)
      .json({ status: false, message: 'Failed to change password', error: err.message });
  }
};
