// controllers/userController.js
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const notify = require('../utils/notify');
const { hashToken } = require('../utils/tokens'); // existing util

// Helper: normalize
function normalize(v) {
  return v === null || typeof v === 'undefined' ? null : String(v).trim();
}
function toLower(v) {
  return v === null ? null : String(v).trim().toLowerCase();
}

/**
 * GET /api/users/me
 * Return basic user profile (no sensitive fields)
 */
exports.getMe = async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query(
      `SELECT id, username, first_name, last_name, email, phone, is_email_verified, role, status, created_at
       FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    if (!rows.length) return res.status(404).json({ message: 'User not found' });
    const user = rows[0];
    res.json({ user });
  } catch (err) {
    console.error('getMe err', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * PUT /api/users/me
 * Update profile fields: first_name, last_name, username, email, phone
 * If email or phone changed -> set is_email_verified = 0 and create verification token & send email
 */
exports.updateProfile = async (req, res) => {
  const userId = req.user.id;
  const {
    first_name,
    last_name,
    username,
    email,
    phone
  } = req.body || {};

  const fn = normalize(first_name);
  const ln = normalize(last_name);
  const un = normalize(username);
  const unLower = un ? un.toLowerCase() : null;
  const emailNorm = email ? toLower(email) : null;
  const phoneNorm = phone ? String(phone).trim() : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Fetch current
    const [curRows] = await conn.query('SELECT id, username, username_lower, email, phone FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!curRows.length) {
      await conn.rollback();
      return res.status(404).json({ message: 'User not found' });
    }
    const current = curRows[0];

    // Uniqueness checks (exclude current user)
    if (unLower && unLower !== current.username_lower) {
      const [uDup] = await conn.query('SELECT id FROM users WHERE username_lower = ? LIMIT 1', [unLower]);
      if (uDup.length) { await conn.rollback(); return res.status(409).json({ message: 'Username taken' }); }
    }
    if (emailNorm && emailNorm !== (current.email && current.email.toLowerCase())) {
      const [eDup] = await conn.query('SELECT id FROM users WHERE email = ? LIMIT 1', [emailNorm]);
      if (eDup.length) { await conn.rollback(); return res.status(409).json({ message: 'Email already used' }); }
    }
    if (phoneNorm && phoneNorm !== current.phone) {
      const [pDup] = await conn.query('SELECT id FROM users WHERE phone = ? LIMIT 1', [phoneNorm]);
      if (pDup.length) { await conn.rollback(); return res.status(409).json({ message: 'Phone already used' }); }
    }

    // Build update fields
    const updates = [];
    const params = [];

    if (fn) { updates.push('first_name = ?'); params.push(fn); }
    if (ln) { updates.push('last_name = ?'); params.push(ln); }
    if (un) { updates.push('username = ?', 'username_lower = ?'); params.push(un, unLower); }
    if (emailNorm) { updates.push('email = ?'); params.push(emailNorm); }
    if (phoneNorm) { updates.push('phone = ?'); params.push(phoneNorm); }

    if (updates.length === 0) {
      await conn.rollback();
      return res.status(400).json({ message: 'No valid fields to update' });
    }

    // If email or phone changed -> mark not verified and create verification token (email)
    const emailChanged = emailNorm && emailNorm !== (current.email && current.email.toLowerCase());
    const phoneChanged = phoneNorm && phoneNorm !== current.phone;

    if (emailChanged || phoneChanged) {
      // set flags in update
      updates.push('is_email_verified = 0', "status = 'pending_verification'");
    }

    const updateSql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
    params.push(userId);
    await conn.execute(updateSql, params);

    // If email changed, create a verification token and send email (async but inside txn we'll insert token)
    if (emailChanged) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = hashToken(rawToken);
      const expires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

      await conn.execute(
        'INSERT INTO verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
        [userId, tokenHash, expires]
      );

      // send email (do not block commit on success/failure, but we will try)
      try {
        const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${rawToken}`;
     try {
  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${rawToken}`;

  await notify({
    userId,
    email: emailNorm,
    title: 'Verify Your New Email Address',
    message: `You recently updated your profile on Trebetta.\n\nPlease verify your new email address by clicking the link below:\n${verifyUrl}\n\nIf you did not make this change, contact support immediately.`,
    type: 'security',
    severity: 'warning',
    metadata: {
      action: 'email_change',
      verify_url: verifyUrl
    }
  });
} catch (nErr) {
  console.error('Profile update notify error', nErr);
}

      } catch (mailErr) {
        // log but proceed
        console.error('Profile update - sendEmail error', mailErr);
      }
    }

    // For phone verification we would create an OTP entry similarly (not implemented here)
    await conn.commit();
if (phoneChanged && !emailChanged) {
  try {
    const [[user]] = await pool.query(
      'SELECT email FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    if (user?.email) {
      await notify({
        userId,
        email: user.email,
        title: 'Profile Updated',
        message: 'Your phone number was updated on your Trebetta account. If you did not make this change, please contact support immediately.',
        type: 'security',
        severity: 'warning',
        metadata: {
          action: 'phone_change'
        }
      });
    }
  } catch (nErr) {
    console.warn('phone change notify failed', nErr);
  }
}

    // Return simple updated profile
    const [updated] = await pool.query('SELECT id, username, first_name, last_name, email, phone, is_email_verified, status FROM users WHERE id = ? LIMIT 1', [userId]);

    res.json({ message: 'Profile updated', user: updated[0] });
  } catch (err) {
    await conn.rollback();
    console.error('updateProfile err', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
};

/**
 * POST /api/users/change-password
 * Body: { current_password, new_password }
 */
exports.changePassword = async (req, res) => {
  const userId = req.user.id;
  const { current_password, new_password } = req.body || {};

  if (!current_password || !new_password) return res.status(400).json({ message: 'current_password and new_password required' });
  if (new_password.length < 8) return res.status(400).json({ message: 'New password must be at least 8 characters' });

  try {
    const [rows] = await pool.query('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!rows.length) return res.status(404).json({ message: 'User not found' });

    const match = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!match) return res.status(401).json({ message: 'Current password incorrect' });

    const newHash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);

    // Revoke all refresh tokens (force re-login)
    await pool.query('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [userId]);
try {
  const [[user]] = await pool.query(
    'SELECT email FROM users WHERE id = ? LIMIT 1',
    [userId]
  );

  if (user?.email) {
    await notify({
      userId,
      email: user.email,
      title: 'Password Changed Successfully',
      message: 'Your Trebetta account password was changed successfully. If this was not you, please reset your password immediately and contact support.',
      type: 'security',
      severity: 'success',
      metadata: {
        action: 'password_change'
      }
    });
  }
} catch (nErr) {
  console.warn('changePassword notify failed', nErr);
}

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    console.error('changePassword err', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
