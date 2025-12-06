// controllers/adminAuthController.js
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { auditLog } = require('./_adminHelpers'); // assumes you have this helper
// config via env
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET || 'change_this_admin_secret';
const ACCESS_EXPIRES = process.env.ADMIN_JWT_EXPIRES || '1d'; // admin token validity
// POST /api/admin/auth/login
exports.login = async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password)
    return res.status(400).json({ message: 'email and password required' });

  try {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE email = ? LIMIT 1',
      [String(email).trim().toLowerCase()]
    );

    if (!rows.length) {
      await auditLog(null, null, 'ADMIN_LOGIN_FAIL', 'admin', null, {
        email,
        reason: 'not_found'
      }).catch(() => {});
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const admin = rows[0];

    if (!admin.role || admin.role !== 'admin') {
      await auditLog(null, admin.id, 'ADMIN_LOGIN_FAIL', 'admin', admin.id, {
        reason: 'not_admin'
      }).catch(() => {});
      return res.status(403).json({ message: 'Access denied' });
    }

    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) {
      await auditLog(null, admin.id, 'ADMIN_LOGIN_FAIL', 'admin', admin.id, {
        reason: 'bad_password'
      }).catch(() => {});
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // -------------------------------
    // 1) CREATE JWT TOKEN
    // -------------------------------
    const token = jwt.sign(
      {
        id: admin.id,
        role: admin.role
      },
      ADMIN_JWT_SECRET,
      { expiresIn: ACCESS_EXPIRES }
    );

    // -------------------------------
    // 2) CREATE ADMIN SESSION
    // -------------------------------
    const { createAdminSession } = require('../services/adminSessionService');

    const sessionId = await createAdminSession(
      admin.id,
      req.ip,
      req.headers['user-agent'] || null
    );

    // -------------------------------
    // 3) UPDATE LAST LOGIN
    // -------------------------------
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [
      admin.id
    ]);

    await auditLog(
      null,
      admin.id,
      'ADMIN_LOGIN_SUCCESS',
      'admin',
      admin.id,
      { ip: req.ip }
    ).catch(() => {});

    // -------------------------------
    // 4) RETURN TOKEN + SESSION ID
    // -------------------------------
    return res.json({
      message: 'Login successful',
      token,
      session_id: sessionId,
      admin: {
        id: admin.id,
        email: admin.email,
        username: admin.username || null,
        role: admin.role
      }
    });
  } catch (err) {
    console.error('admin login err', err);
    return res.status(500).json({
      message: 'Server error',
      error: err.message
    });
  }
};

// POST /api/admin/auth/logout
exports.logout = async (req, res) => {
  try {
    const adminId = req.user?.id || null;
    // If you use token blacklisting, add here. We simply audit and return success.
    await auditLog(null, adminId, 'ADMIN_LOGOUT', 'admin', adminId, { ip: req.ip }).catch(()=>{});
    return res.json({ message: 'Logged out' });
  } catch (err) {
    console.error('admin logout err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// POST /api/admin/auth/forgot-password
exports.forgotPassword = async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ message: 'email required' });

  try {
    const [rows] = await pool.query('SELECT id, email FROM users WHERE email = ? AND role = ? LIMIT 1', [
      String(email).trim().toLowerCase(),
      'admin'
    ]);
    if (!rows.length) {
      // Do not reveal admin existence; respond success.
      return res.json({ message: 'If an admin account exists, a reset token was created' });
    }
    const admin = rows[0];

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hashed = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expires = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    // Use your reset_tokens table (same as user reset) - mark source as 'admin' optional
    await pool.query(
      'INSERT INTO reset_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, NOW())',
      [admin.id, hashed, expires]
    );

    // TODO: send email (use your mailer util). For now return token for testing.
    await auditLog(null, admin.id, 'ADMIN_FORGOT_PASSWORD', 'admin', admin.id, { }).catch(()=>{});

    return res.json({ message: 'Reset token created (for testing only)', resetToken: rawToken });
  } catch (err) {
    console.error('admin forgot err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// POST /api/admin/auth/reset-password
exports.resetPassword = async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ message: 'token and password required' });

  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const [rows] = await pool.query(
      'SELECT * FROM reset_tokens WHERE token_hash = ? AND used = 0 AND expires_at >= NOW() LIMIT 1',
      [tokenHash]
    );
    if (!rows.length) return res.status(400).json({ message: 'Invalid or expired token' });

    const rec = rows[0];

    // Ensure user is admin
    const [uRows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [rec.user_id]);
    if (!uRows.length || uRows[0].role !== 'admin') {
      return res.status(400).json({ message: 'Invalid token user' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, rec.user_id]);
    await pool.query('UPDATE reset_tokens SET used = 1 WHERE id = ?', [rec.id]);

    await auditLog(null, rec.user_id, 'ADMIN_PASSWORD_RESET', 'admin', rec.user_id, {}).catch(()=>{});

    return res.json({ message: 'Password reset successful' });
  } catch (err) {
    console.error('admin reset err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

// GET /api/admin/auth/profile
exports.profile = async (req, res) => {
  try {
    const id = req.user?.id;
    if (!id) return res.status(401).json({ message: 'Unauthorized' });
    const [rows] = await pool.query('SELECT id, email, username, first_name, last_name, role, status, last_login FROM users WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) return res.status(404).json({ message: 'Admin not found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('admin profile err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};