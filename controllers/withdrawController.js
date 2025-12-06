// controllers/withdrawController.js
const pool = require('../config/db');
const bcrypt = require('bcryptjs');

const generateReference = require('../utils/generateReference');
const { auditLog } = require('../utils/auditLog');
const sendEmail = require('../utils/mailer');
const limits = require('../utils/limits');
const { resolveBankAccount } = require('../services/flutterwaveBankService');
const walletService = require('../services/walletService');
const slipService = require('../services/slipService');
const { getSystemSetting } = require('../services/settingsService');
const logger = require('../utils/logger');

const WITHDRAWAL_EXPIRE_MIN = limits.WITHDRAWAL_CONFIRM_EXPIRES_MIN || 10;

/**
 * ---------------------------------------------------------
 * Helper: get effective min_withdraw from system_settings
 * Fallback to limits.MIN_WITHDRAWAL if not set.
 * ---------------------------------------------------------
 */
async function getEffectiveMinWithdraw() {
  try {
    const v = await getSystemSetting('min_withdraw');
    const n = Number(v);
    if (!Number.isNaN(n) && n > 0) return n;
  } catch (e) {
    logger && logger.warn && logger.warn('getEffectiveMinWithdraw › setting error', e);
  }
  return limits.MIN_WITHDRAWAL || 1000;
}

/**
 * ---------------------------------------------------------
 * Helper: get withdrawal fee from withdraw_fee_rules JSON
 * in system_settings.
 *
 * Expected JSON shape (example):
 * [
 *   { "min": 1000, "max": 3000,  "fee": 20 },
 *   { "min": 4000, "max": 9000,  "fee": 30 },
 *   { "min": 100000, "max": null, "fee": 100 }
 * ]
 *
 * If not configured or invalid, fallback to limits.getWithdrawalFee.
 * ---------------------------------------------------------
 */
async function getDynamicWithdrawalFee(amount) {
  const amt = Number(amount);
  if (!amt || amt <= 0) return 0;

  let rawRules;
  try {
    rawRules = await getSystemSetting('withdraw_fee_rules');
  } catch (e) {
    logger && logger.warn && logger.warn('getDynamicWithdrawalFee › getSystemSetting error', e);
  }

  if (!rawRules) {
    // fallback to legacy behaviour
    return typeof limits.getWithdrawalFee === 'function'
      ? limits.getWithdrawalFee(amt)
      : 0;
  }

  let rules;
  try {
    rules = typeof rawRules === 'string' ? JSON.parse(rawRules) : rawRules;
  } catch (e) {
    logger && logger.warn && logger.warn('getDynamicWithdrawalFee › JSON parse error', e);
    return typeof limits.getWithdrawalFee === 'function'
      ? limits.getWithdrawalFee(amt)
      : 0;
  }

  if (!Array.isArray(rules) || !rules.length) {
    return typeof limits.getWithdrawalFee === 'function'
      ? limits.getWithdrawalFee(amt)
      : 0;
  }

  // find first rule where amount in [min, max]
  for (const rule of rules) {
    const min = Number(rule.min || 0);
    const max = rule.max === null || rule.max === undefined
      ? Infinity
      : Number(rule.max);
    const fee = Number(rule.fee || 0);

    if (!Number.isNaN(min) && !Number.isNaN(max) && amt >= min && amt <= max) {
      return Number.isNaN(fee) ? 0 : fee;
    }
  }

  // no matching rule → no fee OR fallback
  return 0;
}

/**
 * ---------------------------------------------------------
 * INITIATE WITHDRAWAL (SEND OTP + CREATE REQUEST)
 * ---------------------------------------------------------
 */
async function initiateWithdraw(req, res) {
  const user = req.user;
  const userId = user.id;
  const { amount, bank_code, account_number, pin } = req.body;

  console.log('withdrawController.initiateWithdraw › user:', userId, 'amount:', amount);

  try {
    const parsedAmount = Number(amount);
    const minWithdraw = await getEffectiveMinWithdraw();

    if (!parsedAmount || parsedAmount <= 0 || parsedAmount < minWithdraw) {
      console.warn('withdrawController.initiateWithdraw › invalid amount:', amount, 'min:', minWithdraw);
      return res.status(400).json({
        status: false,
        message: 'Invalid withdrawal amount'
      });
    }

    // Verify transaction PIN
    if (!user.transaction_pin_hash) {
      return res.status(400).json({ status: false, message: 'Transaction PIN not set' });
    }

    const pinOk = await bcrypt.compare(String(pin), String(user.transaction_pin_hash));
    if (!pinOk) {
      console.warn('withdrawController.initiateWithdraw › invalid PIN for user:', userId);
      return res.status(400).json({ status: false, message: 'Invalid PIN' });
    }

    // Get wallet
    const [walletRows] = await pool.query(
      'SELECT id, balance FROM wallets WHERE user_id = ? LIMIT 1',
      [userId]
    );

    if (!walletRows.length) {
      return res.status(400).json({ status: false, message: 'Wallet not found' });
    }

    const wallet = walletRows[0];

    if (Number(wallet.balance) < parsedAmount) {
      return res.status(400).json({ status: false, message: 'Insufficient wallet balance' });
    }

    // KYC limits
    let tier = user.kyc_tier || user.kyc_status || 'tier1';
    let tierObj = limits.getLimitsForTier(String(tier).toLowerCase());

    if (parsedAmount > tierObj.daily) {
      return res.status(400).json({
        status: false,
        message: 'Amount exceeds your daily withdrawal limit'
      });
    }

    // Resolve bank via Flutterwave
    let resolved;
    try {
      resolved = await resolveBankAccount(bank_code, account_number);
    } catch (err) {
      console.warn('withdrawController.initiateWithdraw › bank resolve failed.', err?.message || err);
      return res.status(400).json({
        status: false,
        message: 'Could not verify bank account. Please check the details.'
      });
    }

    // Save bank account
    await pool.query(
      `INSERT INTO saved_accounts (user_id, bank_code, account_number, account_name, created_at)
       SELECT ?, ?, ?, ?, NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM saved_accounts
         WHERE user_id = ? AND bank_code = ? AND account_number = ?
       )`,
      [
        userId,
        resolved.bank_code,
        resolved.account_number,
        resolved.account_name,
        userId,
        resolved.bank_code,
        resolved.account_number
      ]
    );

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpHash = await bcrypt.hash(String(otp), 10);
    const expiresAt = new Date(Date.now() + WITHDRAWAL_EXPIRE_MIN * 60 * 1000);

    const reference = generateReference('WD');

    // NEW: fee from system settings (withdraw_fee_rules) with fallback
    const fee = await getDynamicWithdrawalFee(parsedAmount);
    const currency = 'NGN';

    const metadata = {
      otp_hash: otpHash,
      otp_expires_at: expiresAt.toISOString(),
      bank_resolve_raw: resolved.raw || null
    };

    // Insert withdrawal request
    const [wr] = await pool.query(
      `INSERT INTO withdrawal_requests
       (user_id, wallet_id, amount, fee, currency, status, reference,
        bank_name, account_number, account_name, requested_at, metadata)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NOW(), ?)`,
      [
        userId,
        wallet.id,
        parsedAmount,
        fee,
        currency,
        reference,
        resolved.bank_name,
        resolved.account_number,
        resolved.account_name,
        JSON.stringify(metadata)
      ]
    );

    console.log('withdrawController.initiateWithdraw › withdrawal_requests.id:', wr.insertId);

    // Send OTP
    try {
      await sendEmail(
        user.email,
        'Trebetta Withdrawal OTP',
        `Your OTP is ${otp}. It expires in ${WITHDRAWAL_EXPIRE_MIN} minutes.`
      );
    } catch (emailErr) {
      console.error('withdrawController.initiateWithdraw › OTP email error:', emailErr);
    }

    await auditLog(
      userId,
      'withdraw_initiated',
      `Withdrawal started for ₦${parsedAmount}`,
      { reference, amount: parsedAmount, fee }
    );

    return res.json({
      status: true,
      message: 'Withdrawal OTP sent to your email',
      data: { reference, fee, currency }
    });

  } catch (err) {
    console.error('❌ withdrawController.initiateWithdraw ERROR:', err);
    return res.status(500).json({ status: false, message: 'Withdrawal initiation failed' });
  }
}

/**
 * ---------------------------------------------------------
 * CONFIRM WITHDRAWAL
 * ---------------------------------------------------------
 */
async function confirmWithdraw(req, res) {
  const user = req.user;
  const userId = user.id;
  const { reference, otp } = req.body;

  console.log('withdrawController.confirmWithdraw › user:', userId, 'reference:', reference);

  try {
    if (!reference || !otp) {
      return res.status(400).json({ status: false, message: 'Reference and OTP required' });
    }

    const [rows] = await pool.query(
      `SELECT * FROM withdrawal_requests WHERE reference = ? AND user_id = ? LIMIT 1`,
      [reference, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ status: false, message: 'Request not found' });
    }

    const wr = rows[0];

    if (wr.status !== 'pending') {
      return res.status(400).json({ status: false, message: 'Withdrawal is no longer pending' });
    }

    const meta = wr.metadata ? JSON.parse(wr.metadata) : {};
    const otpHash = meta.otp_hash;
    const otpExpiresAt = meta.otp_expires_at ? new Date(meta.otp_expires_at) : null;

    if (!otpHash || !otpExpiresAt) {
      return res.status(400).json({ status: false, message: 'OTP missing for this request' });
    }

    if (new Date() > otpExpiresAt) {
      return res.status(400).json({ status: false, message: 'OTP expired' });
    }

    const match = await bcrypt.compare(String(otp), otpHash);
    if (!match) {
      return res.status(400).json({ status: false, message: 'Invalid OTP' });
    }

    // Debit wallet in transaction
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [walletRows] = await conn.query(
        'SELECT id, balance FROM wallets WHERE user_id = ? LIMIT 1 FOR UPDATE',
        [userId]
      );

      if (!walletRows.length) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ status: false, message: 'Wallet not found' });
      }

      const wallet = walletRows[0];

      if (Number(wallet.balance) < Number(wr.amount)) {
        await conn.rollback();
        conn.release();
        return res.status(400).json({ status: false, message: 'Insufficient balance' });
      }

      const balanceBefore = Number(wallet.balance);

      await walletService.debitUserWallet(
        conn,
        userId,
        wr.amount,
        'withdrawal'
        // we can still rely on default type='withdrawal' inside walletService
      );

      const [[walletAfter]] = await conn.query(
        'SELECT balance FROM wallets WHERE id = ? LIMIT 1',
        [wallet.id]
      );

      await conn.query(
        `UPDATE withdrawal_requests
         SET status = 'processing',
             balance_before = ?,
             balance_after = ?,
             processed_at = NOW(),
             metadata = JSON_SET(IFNULL(metadata, '{}'), '$.otp_verified_at', NOW())
         WHERE id = ?`,
        [balanceBefore, walletAfter.balance, wr.id]
      );

      await auditLog(
        userId,
        'withdraw_confirmed',
        `Withdrawal confirmed for ₦${wr.amount}`,
        { reference }
      );

      // Create withdrawal slip (best-effort)
      try {
        const [[userRow]] = await pool.query(
          'SELECT username FROM users WHERE id = ? LIMIT 1',
          [wr.user_id]
        );

        const maskedAccount = wr.account_number
          ? wr.account_number.slice(-4).padStart(wr.account_number.length, '*')
          : null;

        const payload = {
          amount: Number(wr.amount),
          bank_name: wr.bank_name || null,
          bank_account: maskedAccount,
          provider: 'manual', // e.g. 'flutterwave', 'manual'
          reference: wr.reference,
          user_masked: (userRow?.username
            ? (userRow.username.length <= 2
              ? `${userRow.username[0]}*`
              : `${userRow.username.slice(0, 3)}***`)
            : 'user'),
          created_at: new Date().toISOString()
        };

        await slipService.createSlip(wr.user_id, 'withdrawal', payload);
      } catch (e) {
        logger && logger.warn && logger.warn('createSlip withdrawal failed', e);
      }

      await conn.commit();
      conn.release();

      return res.json({
        status: true,
        message: 'Withdrawal is now processing'
      });

    } catch (txErr) {
      console.error('withdrawController.confirmWithdraw › TX ERROR:', txErr);
      await conn.rollback();
      conn.release();
      return res.status(500).json({ status: false, message: 'Could not confirm withdrawal' });
    }

  } catch (err) {
    console.error('❌ withdrawController.confirmWithdraw ERROR:', err);
    return res.status(500).json({ status: false, message: 'Withdrawal confirmation failed' });
  }
}

/**
 * ---------------------------------------------------------
 * CREATE TRANSACTION PIN
 * ---------------------------------------------------------
 */
async function createPin(req, res) {
  const user = req.user;
  const userId = user.id;
  const { pin } = req.body;

  console.log('withdrawController.createPin › user:', userId);

  try {
    if (!pin || String(pin).length < 4) {
      return res.status(400).json({ status: false, message: 'PIN must be at least 4 digits' });
    }

    if (user.transaction_pin_hash) {
      return res.status(400).json({ status: false, message: 'PIN already created' });
    }

    const hashed = await bcrypt.hash(String(pin), 10);

    await pool.query(
      `UPDATE users SET transaction_pin_hash = ? WHERE id = ? LIMIT 1`,
      [hashed, userId]
    );

    await auditLog(
      null,
      userId,
      'pin_created',
      'transaction_pin',
      null,
      { message: 'PIN created' }
    );

    return res.json({ status: true, message: 'Transaction PIN created successfully' });

  } catch (err) {
    console.error('❌ withdrawController.createPin ERROR:', err);
    return res.status(500).json({ status: false, message: 'Could not create PIN' });
  }
}

/**
 * ---------------------------------------------------------
 * CHANGE PIN
 * ---------------------------------------------------------
 */
async function changePin(req, res) {
  const user = req.user;
  const userId = user.id;
  const { old_pin, new_pin } = req.body;

  console.log('withdrawController.changePin › user:', userId);

  try {
    if (!old_pin || !new_pin) {
      return res.status(400).json({ status: false, message: 'Old and new PIN required' });
    }

    const match = await bcrypt.compare(String(old_pin), String(user.transaction_pin_hash));
    if (!match) {
      return res.status(400).json({ status: false, message: 'Old PIN incorrect' });
    }

    if (String(new_pin).length < 4) {
      return res.status(400).json({ status: false, message: 'PIN must be at least 4 digits' });
    }

    const hashed = await bcrypt.hash(String(new_pin), 10);

    await pool.query(
      `UPDATE users SET transaction_pin_hash = ? WHERE id = ? LIMIT 1`,
      [hashed, userId]
    );

    await auditLog(
      null,
      userId,
      'pin_changed',
      'transaction_pin',
      null,
      { message: 'PIN changed' }
    );

    return res.json({ status: true, message: 'PIN changed successfully' });

  } catch (err) {
    console.error('❌ withdrawController.changePin ERROR:', err);
    return res.status(500).json({ status: false, message: 'PIN change failed' });
  }
}

/**
 * ---------------------------------------------------------
 * VERIFY PIN
 * ---------------------------------------------------------
 */
async function verifyPin(req, res) {
  const user = req.user;
  const userId = user.id;
  const { pin } = req.body;

  console.log('withdrawController.verifyPin › user:', userId);

  try {
    if (!pin) {
      return res.status(400).json({ status: false, message: 'PIN required' });
    }

    const match = await bcrypt.compare(String(pin), String(user.transaction_pin_hash));
    if (!match) {
      return res.status(400).json({ status: false, message: 'Invalid PIN' });
    }

    return res.json({
      status: true,
      message: 'PIN verified'
    });

  } catch (err) {
    console.error('❌ withdrawController.verifyPin ERROR:', err);
    return res.status(500).json({ status: false, message: 'Could not verify PIN' });
  }
}

// ---------------------------------------------------------
// REQUEST PIN RESET (user provides password)
// ---------------------------------------------------------
async function requestPinReset(req, res) {
  const user = req.user;
  const userId = user.id;
  const { password } = req.body;

  console.log('withdrawController.requestPinReset › user:', userId);

  try {
    if (!password) {
      return res.status(400).json({ status: false, message: 'Password is required' });
    }

    // Fetch user's password_hash
    const [rows] = await pool.query(
      `SELECT password_hash FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ status: false, message: 'User not found' });
    }

    const storedHash = rows[0].password_hash;

    // Protect against NULL hash
    if (!storedHash) {
      return res.status(500).json({
        status: false,
        message: 'Password not set for this account. Contact support.'
      });
    }

    // Validate user password
    const ok = await bcrypt.compare(String(password), String(storedHash));

    if (!ok) {
      return res.status(400).json({ status: false, message: 'Incorrect password' });
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpHash = await bcrypt.hash(String(otp), 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    // Save OTP + expiry
    await pool.query(
      `UPDATE users
       SET pin_reset_otp_hash = ?, pin_reset_otp_expiry = ?
       WHERE id = ? LIMIT 1`,
      [otpHash, expiresAt, userId]
    );

    // Send OTP email
    try {
      await sendEmail(
        user.email,
        'Trebetta PIN Reset OTP',
        `Your OTP for resetting your transaction PIN is ${otp}. It expires in 10 minutes.`
      );
    } catch (emailErr) {
      console.error('requestPinReset › OTP email error:', emailErr);
    }

    await auditLog(
      null,
      userId,
      'pin_reset_requested',
      'transaction_pin',
      null,
      { message: 'User requested PIN reset' }
    );

    return res.json({
      status: true,
      message: 'PIN reset OTP sent to your email'
    });

  } catch (err) {
    console.error('❌ requestPinReset ERROR:', err);
    return res.status(500).json({ status: false, message: 'Could not request PIN reset' });
  }
}

// ---------------------------------------------------------
// RESET TRANSACTION PIN (OTP + new PIN)
// ---------------------------------------------------------
async function resetPin(req, res) {
  const user = req.user;
  const userId = user.id;
  const { otp, new_pin } = req.body;

  console.log('withdrawController.resetPin › user:', userId);

  try {
    if (!otp || !new_pin) {
      return res.status(400).json({ status: false, message: 'OTP and new PIN are required' });
    }

    if (String(new_pin).length < 4) {
      return res.status(400).json({ status: false, message: 'New PIN must be at least 4 digits' });
    }

    // Fetch OTP info
    const [rows] = await pool.query(
      `SELECT pin_reset_otp_hash, pin_reset_otp_expiry
       FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({ status: false, message: 'User not found' });
    }

    const { pin_reset_otp_hash, pin_reset_otp_expiry } = rows[0];

    if (!pin_reset_otp_hash || !pin_reset_otp_expiry) {
      return res.status(400).json({ status: false, message: 'No active PIN reset request' });
    }

    if (new Date() > new Date(pin_reset_otp_expiry)) {
      return res.status(400).json({ status: false, message: 'OTP has expired' });
    }

    const otpOk = await bcrypt.compare(String(otp), String(pin_reset_otp_hash));
    if (!otpOk) {
      return res.status(400).json({ status: false, message: 'Invalid OTP' });
    }

    // Hash new pin
    const newHash = await bcrypt.hash(String(new_pin), 10);

    // Update PIN + clear OTP fields
    await pool.query(
      `UPDATE users
       SET transaction_pin_hash = ?, pin_reset_otp_hash = NULL, pin_reset_otp_expiry = NULL
       WHERE id = ? LIMIT 1`,
      [newHash, userId]
    );

    await auditLog(
      null,
      userId,
      'pin_reset_completed',
      'transaction_pin',
      null,
      { message: 'User completed PIN reset' }
    );

    return res.json({
      status: true,
      message: 'Transaction PIN reset successfully'
    });

  } catch (err) {
    console.error('❌ resetPin ERROR:', err);
    return res.status(500).json({ status: false, message: 'Could not reset PIN' });
  }
}

module.exports = {
  initiateWithdraw,
  confirmWithdraw,
  createPin,
  changePin,
  verifyPin,
  requestPinReset,
  resetPin
};
