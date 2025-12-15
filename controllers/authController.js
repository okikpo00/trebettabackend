// controllers/authController.js
const pool = require('../config/db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const validator = require('validator');
const notify = require('../utils/notify');

const { genAccessToken, genRefreshToken, hashToken } = require('../utils/tokens');
const { auditLog } = require('../utils/auditLog');

const REFRESH_COOKIE_NAME = process.env.COOKIE_NAME_REFRESH || 'trebetta_rt';
const REFRESH_EXPIRES_DAYS = Number(process.env.JWT_REFRESH_EXPIRES_DAYS || 7);
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES || '1h';
const PASSWORD_RESET_EXPIRES_MIN = Number(process.env.PASSWORD_RESET_EXPIRES_MIN || 15);
const VERIFICATION_TOKEN_EXP_HOURS = Number(process.env.EMAIL_VERIFICATION_EXPIRES_HOURS || 2);
const FAILED_LOGIN_LIMIT = 5;
const LOCKOUT_MINUTES = 15;

// ---------------------
// Helpers
// ---------------------
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizePhone(phone) {
  if (!phone) return null;
  let cleaned = phone.replace(/\D/g, ''); // remove non-numeric
  if (cleaned.startsWith('0')) cleaned = '234' + cleaned.slice(1);
  if (!cleaned.startsWith('234')) cleaned = '234' + cleaned;
  return '+' + cleaned;
}

function nowPlusMinutes(min) {
  return new Date(Date.now() + min * 60 * 1000);
}

async function safeSendEmail(to, subject, html) {
  try {
    if (typeof sendEmail === 'function') await sendEmail(to, subject, html);
  } catch (e) {
    console.warn('⚠️ sendEmail failed:', e?.message || e);
  }
}

function isPasswordStrong(password) {
  const re = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?])?.{8,}$/;
  return re.test(password);
}

// ---------------------
// Wallet helper
// ---------------------
async function ensureWalletForUser(conn, userId) {
  const q = 'SELECT id, balance FROM wallets WHERE user_id = ? LIMIT 1';
  const [rows] = await (conn.query ? conn.query(q, [userId]) : pool.query(q, [userId]));
  if (rows.length) return { id: rows[0].id, balance: Number(rows[0].balance || 0) };

  const insertQ =
    'INSERT INTO wallets (user_id, balance, reserved_balance, currency, status, created_at, updated_at) VALUES (?, 0.00, 0.00, ?, "active", NOW(), NOW())';
  const currency = process.env.DEFAULT_CURRENCY || 'NGN';

  const result = conn.execute ? await conn.execute(insertQ, [userId, currency]) : await pool.execute(insertQ, [userId, currency]);
  const insertId = result[0]?.insertId || (result.insertId ? result.insertId : null);
  if (!insertId) throw new Error('failed_create_wallet');
  return { id: insertId, balance: 0.0 };
}

// ---------------------
// Find user by identifier
// ---------------------
async function findUserByIdentifier(identifier) {
  const idTrim = String(identifier).trim();
  let rows = [];
  if (validator.isEmail(idTrim)) {
    [rows] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [normalizeEmail(idTrim)]);
  } else if (/^\+?\d+$/.test(idTrim)) {
    const phoneNorm = normalizePhone(idTrim);
    [rows] = await pool.query('SELECT * FROM users WHERE phone = ? LIMIT 1', [phoneNorm]);
  } else {
    [rows] = await pool.query('SELECT * FROM users WHERE username_lower = ? LIMIT 1', [idTrim.toLowerCase()]);
  }
  return rows.length ? rows[0] : null;
}

// ---------------------
// Registration
// ---------------------
exports.register = async (req, res) => {
  const { email, phone, password, first_name, last_name, username } = req.body || {};

  if (!email || !password || (!first_name && !last_name)) {
    return res.status(400).json({ success: false, message: 'Email, password, and name required' });
  }
  if (!isPasswordStrong(password)) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 chars, include letters and numbers, optionally symbols' });
  }

  const emailNorm = normalizeEmail(email);
  const phoneNorm = normalizePhone(phone);
  const uname = username ? String(username).trim() : null;
  const usernameLower = uname ? uname.toLowerCase() : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [dupRows] = await conn.query(
      'SELECT id, email, username, phone FROM users WHERE email = ? OR username_lower = ? OR phone = ? LIMIT 1',
      [emailNorm, usernameLower, phoneNorm]
    );
    if (dupRows.length) {
      await conn.rollback();
      const d = dupRows[0];
      if (d.email === emailNorm) return res.status(409).json({ success: false, message: 'Email already registered' });
      if (uname && d.username === uname) return res.status(409).json({ success: false, message: 'Username already taken' });
      if (d.phone === phoneNorm) return res.status(409).json({ success: false, message: 'Phone number already registered' });
      return res.status(409).json({ success: false, message: 'Account conflict' });
    }

    const passwordHash = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS || 12));

    const insertUserQ = `INSERT INTO users
      (username, username_lower, first_name, last_name, email, phone, password_hash, role, status, is_email_verified, failed_logins, type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'user', 'active', 0, 0,'regular', NOW(), NOW())`;

    const [result] = await conn.execute(insertUserQ, [
      username,
      usernameLower,
      first_name || null,
      last_name || null,
      emailNorm,
      phoneNorm,
      passwordHash
    ]);
    const userId = result.insertId;

    await ensureWalletForUser(conn, userId);

    const rawVerifyToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = hashToken(rawVerifyToken);
    const expires = new Date(Date.now() + VERIFICATION_TOKEN_EXP_HOURS * 60 * 60 * 1000);
    await conn.execute(
      'INSERT INTO verification_tokens (user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, NOW())',
      [userId, tokenHash, expires]
    );

  await auditLog(
  null,            // adminId (none)
  userId,          // userId
  'REGISTER',
  'user',
  userId,
  { email: emailNorm, username: uname }
);

    await conn.commit();

    const verifyUrl = `${process.env.FRONTEND_URL || 'https://trebetta.com'}/verify-email?token=${rawVerifyToken}`;
    await notify({
  userId,
  email: emailNorm,
  title: 'Welcome to Trebetta 🎉',
  message: `Welcome ${first_name || ''}! Please verify your email to activate deposits.\n\nVerify here: ${verifyUrl}`,
  type: 'security',
  severity: 'info',
  metadata: {
    action: 'register',
    verify_url: verifyUrl
  }
});

    return res.status(201).json({ success: true, message: 'Registration successful. Verify email to activate deposits.', userId });
  } catch (err) {
    await conn.rollback();
    console.error('register err', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
};

// ---------------------
// Email Verification
// ---------------------
exports.verifyEmail = async (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ success: false, message: 'Token required' });

  try {
    const tokenHash = hashToken(token);
    const [rows] = await pool.query(
      'SELECT * FROM verification_tokens WHERE token_hash = ? AND used = 0 AND expires_at >= NOW() LIMIT 1',
      [tokenHash]
    );
    if (!rows.length) return res.status(400).json({ success: false, message: 'Invalid or expired token' });

    const rec = rows[0];
    const userId = rec.user_id;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('UPDATE users SET is_email_verified = 1, updated_at = NOW() WHERE id = ?', [userId]);
      await conn.execute('UPDATE verification_tokens SET used = 1 WHERE id = ?', [rec.id]);
      await auditLog(
  null,          // adminId
  userId,
  'VERIFY_EMAIL',
  'user',
  userId,
  { via: 'token' }
);
      await conn.commit();
await notify({
  userId,
  email: user.email,
  title: 'Email Verified ✅',
  message: 'Your email has been verified successfully. You can now deposit funds into your Trebetta wallet.',
  type: 'security',
  severity: 'success',
  metadata: {
    action: 'verify_email'
  }
});

      return res.json({ success: true, message: 'Email verified successfully.' });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('verifyEmail err', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};
// ---------------------
// Login
// ---------------------
exports.login = async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ success: false, message: 'Identifier and password required' });

  try {
    const user = await findUserByIdentifier(identifier);
    if (!user) return res.status(401).json({ success: false, message: 'Invalid credentials' });

    // 1) Lockout check
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const waitMinutes = Math.ceil((new Date(user.locked_until) - new Date()) / (60 * 1000));
      return res.status(423).json({ success: false, message: `Account locked. Try again in ${waitMinutes} minute(s).` });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      // Increment failed attempts
      let failed = (user.failed_logins || 0) + 1;
      let lockUntil = null;

      if (failed >= FAILED_LOGIN_LIMIT) {
        lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
      }

      await pool.query('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', [failed, lockUntil, user.id]);

      await auditLog(null, user.id, 'AUTH_FAILED', 'user', user.id, { attempts: failed, locked_until: lockUntil, identifier });

      if (lockUntil) {
        return res.status(423).json({ success: false, message: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.` });
      }
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    // Reset failed attempts
    await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?', [user.id]);

    // Wallet check / create
    const wallet = await ensureWalletForUser(pool, user.id);

    // Generate tokens
    const accessToken = genAccessToken({ id: user.id, role: user.role });
    const rawRefresh = genRefreshToken();
    const refreshHash = hashToken(rawRefresh);
    const refreshExpires = new Date(Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
    await pool.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, NOW())', [
      user.id,
      refreshHash,
      refreshExpires
    ]);

    // Clear old tokens safely: only expired or revoked > 7 days
    await pool.query('DELETE FROM refresh_tokens WHERE (revoked = 1 AND created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)) OR expires_at < NOW()');

    // Set cookie
    res.cookie(REFRESH_COOKIE_NAME, rawRefresh, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000
    });

    await auditLog(null, user.id, 'LOGIN', 'user', user.id, { ip: req.ip });
const hasPin = !!user.transaction_pin_hash;
    return res.json({
      success: true,
      message: 'Login successful',
      token: accessToken,
      user: {
        id: user.id,
        username: user.username,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        wallet,
        is_email_verified: user.is_email_verified,
        has_pin: hasPin
      }
    });
  } catch (err) {
    console.error('login err', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ---------------------
// Refresh Access Token
// ---------------------
exports.refresh = async (req, res) => {
  try {
    const raw = req.cookies[REFRESH_COOKIE_NAME] || req.body.refresh_token;
    if (!raw) return res.status(401).json({ success: false, message: 'No refresh token provided' });

    const hash = hashToken(raw);
    const [rows] = await pool.query('SELECT * FROM refresh_tokens WHERE token_hash = ? AND revoked = 0 AND expires_at >= NOW() LIMIT 1', [hash]);
    if (!rows.length) return res.status(401).json({ success: false, message: 'Invalid refresh token' });

    const rec = rows[0];

    // Revoke current token
    await pool.query('UPDATE refresh_tokens SET revoked = 1 WHERE id = ?', [rec.id]);

    // Issue new refresh token
    const newRaw = genRefreshToken();
    const newHash = hashToken(newRaw);
    const newExpires = new Date(Date.now() + REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
    await pool.query('INSERT INTO refresh_tokens (user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, NOW())', [
      rec.user_id,
      newHash,
      newExpires
    ]);

    // Issue new access token
    const [uRows] = await pool.query('SELECT id, role FROM users WHERE id = ? LIMIT 1', [rec.user_id]);
    if (!uRows.length) return res.status(401).json({ success: false, message: 'User not found' });
    const user = uRows[0];
    const accessToken = genAccessToken({ id: user.id, role: user.role });

    // Set cookie
    res.cookie(REFRESH_COOKIE_NAME, newRaw, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: REFRESH_EXPIRES_DAYS * 24 * 60 * 60 * 1000
    });

    await auditLog(null, user.id, 'REFRESH_TOKEN', 'user', user.id, {});

    return res.json({ success: true, message: 'Access token refreshed', token: accessToken });
  } catch (err) {
    console.error('refresh err', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ---------------------
// Logout
// ---------------------
exports.logout = async (req, res) => {
  try {
    const raw = req.cookies[REFRESH_COOKIE_NAME] || req.body.refresh_token;
    if (raw) {
      const hash = hashToken(raw);
      await pool.query('UPDATE refresh_tokens SET revoked = 1 WHERE token_hash = ?', [hash]);
    }
    res.clearCookie(REFRESH_COOKIE_NAME);
    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    console.error('logout err', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ---------------------
// Forgot Password
// ---------------------
exports.forgotPassword = async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ success: false, message: 'Email required' });

  const emailNorm = normalizeEmail(email);
  try {
    const [rows] = await pool.query('SELECT id, first_name, last_name FROM users WHERE email = ? LIMIT 1', [emailNorm]);
    if (!rows.length) return res.json({ success: true, message: 'If account exists, reset link will be sent' });

    const user = rows[0];
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expires = nowPlusMinutes(PASSWORD_RESET_EXPIRES_MIN);

    await pool.query('INSERT INTO reset_tokens (user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, NOW())', [
      user.id,
      tokenHash,
      expires
    ]);

    const link = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${rawToken}`;
await notify({
  userId: user.id,
  email: emailNorm,
  title: 'Password Reset Requested',
  message: `A password reset was requested for your account.\n\nReset link: ${link}\n\nIf this wasn’t you, please secure your account immediately.`,
  type: 'security',
  severity: 'warning',
  metadata: {
    action: 'password_reset_request',
    reset_link: link
  }
});


    await auditLog(null, user.id, 'FORGOT_PASSWORD', 'user', user.id, {});
    return res.json({ success: true, message: 'If account exists, reset link sent (check email)' });
  } catch (err) {
    console.error('forgot err', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};

// ---------------------
// Reset Password
// ---------------------
exports.resetPassword = async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ success: false, message: 'Token and password required' });

  if (!isPasswordStrong(password)) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 chars, include letters and numbers, optionally symbols' });
  }

  try {
    const tokenHash = hashToken(token);
    const [rows] = await pool.query('SELECT * FROM reset_tokens WHERE token_hash = ? AND used = 0 AND expires_at >= NOW() LIMIT 1', [tokenHash]);
    if (!rows.length) return res.status(400).json({ success: false, message: 'Invalid or expired token' });

    const rec = rows[0];
    const passHash = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS || 12));

    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passHash, rec.user_id]);
    await pool.query('UPDATE reset_tokens SET used = 1 WHERE id = ?', [rec.id]);

    // Revoke old refresh tokens for multi-device safety
    await pool.query('UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?', [rec.user_id]);
await notify({
  userId: rec.user_id,
  email: user.email,
  title: 'Password Reset Successful',
  message: 'Your password has been reset successfully. If this wasn’t you, please contact support immediately.',
  type: 'security',
  severity: 'success',
  metadata: {
    action: 'password_reset_complete'
  }
});

    await auditLog(null, rec.user_id, 'RESET_PASSWORD', 'user', rec.user_id, {});
    return res.json({ success: true, message: 'Password reset successful' });
  } catch (err) {
    console.error('reset err', err);
    return res.status(500).json({ success: false, message: 'Server error', error: err.message });
  }
};
