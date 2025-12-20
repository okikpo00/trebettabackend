// controllers/withdrawController.js
const pool = require('../config/db');
const bcrypt = require('bcryptjs');

const generateReference = require('../utils/generateReference');
const { auditLog } = require('../utils/auditLog');
const notify = require('../utils/notify');
const sendEmail = require('../utils/sendEmail');
const limits = require('../utils/limits');
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

  for (const rule of rules) {
    const min = Number(rule.min || 0);
    const max =
      rule.max === null || rule.max === undefined ? Infinity : Number(rule.max);
    const fee = Number(rule.fee || 0);

    if (!Number.isNaN(min) && !Number.isNaN(max) && amt >= min && amt <= max) {
      return Number.isNaN(fee) ? 0 : fee;
    }
  }

  return 0;
}

/**
 * ---------------------------------------------------------
 * INITIATE WITHDRAWAL (NO GATEWAY RESOLVER)
 *
 * Body options:
 *
 * 1) Use saved account:
 *    {
 *      "amount": 5000,
 *      "saved_account_id": 12,
 *      "pin": "1234"
 *    }
 *
 * 2) New bank details (public mirror/manual):
 *    {
 *      "amount": 5000,
 *      "bank_code": "033",
 *      "bank_name": "STERLING BANK",   // optional but recommended
 *      "account_number": "0123456789",
 *      "account_name": "JOHN DOE",
 *      "pin": "1234",
 *      "save_account": true            // optional
 *    }
 * ---------------------------------------------------------
 */
async function initiateWithdraw(req, res) {
  const user = req.user;
  const userId = user.id;

  const {
    amount,
    pin,
    saved_account_id,
    bank_code,
    bank_name,
    account_number,
    account_name,
    save_account
  } = req.body || {};

  console.log('withdrawController.initiateWithdraw › user:', userId, 'amount:', amount);

  try {
    const parsedAmount = Number(amount);
    const minWithdraw = await getEffectiveMinWithdraw();

    if (!parsedAmount || parsedAmount <= 0 || parsedAmount < minWithdraw) {
      console.warn(
        'withdrawController.initiateWithdraw › invalid amount:',
        amount,
        'min:',
        minWithdraw
      );
      return res.status(400).json({
        status: false,
        message: 'Invalid withdrawal amount'
      });
    }

    // Verify transaction PIN
    if (!user.transaction_pin_hash) {
      return res
        .status(400)
        .json({ status: false, message: 'Transaction PIN not set' });
    }

    const pinOk = await bcrypt.compare(
      String(pin),
      String(user.transaction_pin_hash)
    );
    if (!pinOk) {
      console.warn(
        'withdrawController.initiateWithdraw › invalid PIN for user:',
        userId
      );
      return res
        .status(400)
        .json({ status: false, message: 'Invalid PIN' });
    }

    // Get wallet
    const [walletRows] = await pool.query(
      'SELECT id, balance FROM wallets WHERE user_id = ? LIMIT 1',
      [userId]
    );

    if (!walletRows.length) {
      return res
        .status(400)
        .json({ status: false, message: 'Wallet not found' });
    }

    const wallet = walletRows[0];

    if (Number(wallet.balance) < parsedAmount) {
      return res
        .status(400)
        .json({ status: false, message: 'Insufficient wallet balance' });
    }

    // KYC limits
    const tier = user.kyc_tier || user.kyc_status || 'tier1';
    const tierObj = limits.getLimitsForTier(String(tier).toLowerCase());

    if (parsedAmount > tierObj.daily) {
      return res.status(400).json({
        status: false,
        message: 'Amount exceeds your daily withdrawal limit'
      });
    }

    // -------------------------------------
    //  BANK DETAILS: SAVED OR MANUAL
    // -------------------------------------
    let finalBankCode = null;
    let finalBankName = null;
    let finalAccountNumber = null;
    let finalAccountName = null;
    let metadataBankMode = null;

    // 1) Use saved account
    if (saved_account_id) {
      const [accRows] = await pool.query(
        `SELECT id, bank_code, account_number, account_name 
         FROM saved_accounts 
         WHERE id = ? AND user_id = ? 
         LIMIT 1`,
        [Number(saved_account_id), userId]
      );

      if (!accRows.length) {
        return res.status(404).json({
          status: false,
          message: 'Saved account not found'
        });
      }

      const acc = accRows[0];
      finalBankCode = acc.bank_code;
      finalAccountNumber = acc.account_number;
      finalAccountName = acc.account_name;
      finalBankName = bank_name || null; // optional label from frontend if available
      metadataBankMode = 'saved_account';
    }
    // 2) Manual/new account (public mirror)
    else {
      if (!bank_code || !account_number || !account_name) {
        return res.status(400).json({
          status: false,
          message: 'Bank code, account number and account name are required'
        });
      }

      finalBankCode = String(bank_code).trim();
      finalAccountNumber = String(account_number).trim();
      finalAccountName = String(account_name).trim();
      finalBankName = bank_name ? String(bank_name).trim() : null;
      metadataBankMode = 'manual';

      // Optional: save as user's saved account
      if (save_account) {
        try {
          await pool.query(
            `INSERT INTO saved_accounts (user_id, bank_code, account_number, account_name, created_at)
             SELECT ?, ?, ?, ?, NOW()
             WHERE NOT EXISTS (
               SELECT 1 FROM saved_accounts
               WHERE user_id = ? AND bank_code = ? AND account_number = ?
             )`,
            [
              userId,
              finalBankCode,
              finalAccountNumber,
              finalAccountName,
              userId,
              finalBankCode,
              finalAccountNumber
            ]
          );
        } catch (e) {
          console.warn('initiateWithdraw › save_account insert failed', e.message);
        }
      }
    }

    // -------------------------------------
    //  OTP + WITHDRAWAL REQUEST
    // -------------------------------------
    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpHash = await bcrypt.hash(String(otp), 10);
    const expiresAt = new Date(Date.now() + WITHDRAWAL_EXPIRE_MIN * 60 * 1000);

    const reference = generateReference('WD');

    // Dynamic fee rules
    const fee = await getDynamicWithdrawalFee(parsedAmount);
    const currency = 'NGN';

    const metadata = {
      otp_hash: otpHash,
      otp_expires_at: expiresAt.toISOString(),
      bank_mode: metadataBankMode,
      bank_code: finalBankCode,
      manual_bank_name: finalBankName,
      manual_entry: metadataBankMode === 'manual'
    };

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
        finalBankName,
        finalAccountNumber,
        finalAccountName,
        JSON.stringify(metadata)
      ]
    );

    console.log(
      'withdrawController.initiateWithdraw › withdrawal_requests.id:',
      wr.insertId
    );

    // Send OTP email (best-effort)
   // 🔔 Fire-and-forget notification (must NEVER block withdrawal)
// 🔔 Side effects (SAFE)
setImmediate(async () => {
  // 📧 EMAIL ONLY (OTP ALLOWED)
  try {
    await sendEmail(
      user.email,
      'Trebetta Withdrawal OTP',
      `
        <p>You initiated a withdrawal of ₦${parsedAmount.toLocaleString()}.</p>
        <p><strong>Your OTP is: ${otp}</strong></p>
        <p>This code expires in ${WITHDRAWAL_EXPIRE_MIN} minutes.</p>
        <p>Reference: ${reference}</p>
      `
    );
  } catch (err) {
    console.warn('Withdrawal OTP email failed:', err?.message);
  }

  // 🔔 In-app notification (NO OTP)
  try {
    await notify({
      userId,
      email: null, // 👈 email already sent
      title: 'Withdrawal OTP Sent',
      message: 'A withdrawal OTP has been sent to your email.',
      type: 'withdrawal',
      severity: 'warning',
      metadata: {
        reference,
        amount: parsedAmount,
        fee,
        bank_code: finalBankCode,
        account_number: finalAccountNumber?.slice(-4)
      }
    });
  } catch (err) {
    console.warn('Withdrawal notify failed:', err?.message);
  }
});

    // Proper auditLog (adminId, userId, action, entity, entityId, details)
    try {
      await auditLog(
        null,
        userId,
        'WITHDRAW_INITIATED',
        'withdrawal_requests',
        wr.insertId,
        {
          reference,
          amount: parsedAmount,
          fee,
          bank_code: finalBankCode,
          account_number: finalAccountNumber,
          account_name: finalAccountName,
          bank_mode: metadataBankMode
        }
      );
    } catch (e) {
      console.warn('withdrawController.initiateWithdraw › auditLog failed', e);
    }

    return res.json({
      status: true,
      message: 'Withdrawal OTP sent to your email',
      data: {
        reference,
        fee,
        currency,
        bank: {
          bank_code: finalBankCode,
          bank_name: finalBankName,
          account_number: finalAccountNumber,
          account_name: finalAccountName
        },
        expires_at: expiresAt.toISOString()
      }
    });
  } catch (err) {
    console.error('❌ withdrawController.initiateWithdraw ERROR:', err);
    return res
      .status(500)
      .json({ status: false, message: 'Withdrawal initiation failed' });
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
  const { reference, otp } = req.body || {};

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

    let meta = {};

if (wr.metadata) {
  if (typeof wr.metadata === 'string') {
    try {
      meta = JSON.parse(wr.metadata);
    } catch (e) {
      console.warn('withdrawController.confirmWithdraw › invalid metadata JSON', e);
      meta = {};
    }
  } else if (typeof wr.metadata === 'object') {
    meta = wr.metadata;
  }
}

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

    // ---------------- TRANSACTION ----------------
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [walletRows] = await conn.query(
        'SELECT id, balance FROM wallets WHERE user_id = ? LIMIT 1 FOR UPDATE',
        [userId]
      );

      if (!walletRows.length) {
        await conn.rollback();
        return res.status(400).json({ status: false, message: 'Wallet not found' });
      }

      const wallet = walletRows[0];
      const amount = Number(wr.amount);
      const fee = Number(wr.fee || 0);

      if (wallet.balance < amount) {
        await conn.rollback();
        return res.status(400).json({ status: false, message: 'Insufficient balance' });
      }

      const balanceBefore = Number(wallet.balance);
      const payoutAmount = amount - fee; // ✅ EXPLICIT

      // Debit FULL amount (correct)
      await walletService.debitUserWallet(conn, userId, amount, 'withdrawal');

      const [[walletAfter]] = await conn.query(
        'SELECT balance FROM wallets WHERE id = ? LIMIT 1',
        [wallet.id]
      );

      // Persist payout math safely
      await conn.query(
        `UPDATE withdrawal_requests
         SET status = 'processing',
             balance_before = ?,
             balance_after = ?,
             processed_at = NOW(),
             metadata = JSON_SET(
               IFNULL(metadata, '{}'),
               '$.otp_verified_at', NOW(),
               '$.payout_amount', ?,
               '$.fee', ?
             )
         WHERE id = ?`,
        [balanceBefore, walletAfter.balance, payoutAmount, fee, wr.id]
      );

      await auditLog(
        null,
        userId,
        'WITHDRAW_CONFIRMED',
        'withdrawal_requests',
        wr.id,
        { reference, amount, fee, payout_amount: payoutAmount }
      );

      await conn.commit();
      conn.release();

      // 🔔 Unified notify (post-commit)
      try {
        await notify({
          userId,
          email: user.email,
          title: 'Withdrawal Processing',
          message: `Your withdrawal of ₦${amount.toLocaleString()} is now processing.\nYou will receive ₦${payoutAmount.toLocaleString()} after fees.`,
          type: 'withdrawal',
          severity: 'info',
          metadata: { reference, amount, fee, payout_amount: payoutAmount }
        });
      } catch (nErr) {
        console.warn('withdraw confirm notify failed', nErr);
      }

      return res.json({ status: true, message: 'Withdrawal is now processing' });

    } catch (txErr) {
      await conn.rollback();
      conn.release();
      throw txErr;
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
  const { pin } = req.body || {};

  console.log('withdrawController.createPin › user:', userId);

  try {
    if (!pin || String(pin).length < 4) {
      return res.status(400).json({
        status: false,
        message: 'PIN must be at least 4 digits'
      });
    }

    if (user.transaction_pin_hash) {
      return res
        .status(400)
        .json({ status: false, message: 'PIN already created' });
    }

    const hashed = await bcrypt.hash(String(pin), 10);

    await pool.query(
      `UPDATE users SET transaction_pin_hash = ? WHERE id = ? LIMIT 1`,
      [hashed, userId]
    );

    await auditLog(
      null,
      userId,
      'PIN_CREATED',
      'transaction_pin',
      null,
      { message: 'PIN created' }
    );
try {
  await notify({
    userId,
    email: user.email,
    title: 'Transaction PIN Created',
    message: 'Your transaction PIN was created successfully.',
    type: 'security',
    severity: 'success',
    metadata: { action: 'pin_created' }
  });
} catch (e) {
  console.warn('PIN created notify failed', e);
}

    return res.json({
      status: true,
      message: 'Transaction PIN created successfully'
    });
  } catch (err) {
    console.error('❌ withdrawController.createPin ERROR:', err);
    return res
      .status(500)
      .json({ status: false, message: 'Could not create PIN' });
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
  const { old_pin, new_pin } = req.body || {};

  console.log('withdrawController.changePin › user:', userId);

  try {
    if (!old_pin || !new_pin) {
      return res.status(400).json({
        status: false,
        message: 'Old and new PIN required'
      });
    }

    const match = await bcrypt.compare(
      String(old_pin),
      String(user.transaction_pin_hash)
    );
    if (!match) {
      return res
        .status(400)
        .json({ status: false, message: 'Old PIN incorrect' });
    }

    if (String(new_pin).length < 4) {
      return res.status(400).json({
        status: false,
        message: 'PIN must be at least 4 digits'
      });
    }

    const hashed = await bcrypt.hash(String(new_pin), 10);

    await pool.query(
      `UPDATE users SET transaction_pin_hash = ? WHERE id = ? LIMIT 1`,
      [hashed, userId]
    );

    await auditLog(
      null,
      userId,
      'PIN_CHANGED',
      'transaction_pin',
      null,
      { message: 'PIN changed' }
    );
try {
  await notify({
    userId,
    email: user.email,
    title: 'Transaction PIN Changed',
    message: 'Your transaction PIN was changed successfully. If this wasn’t you, contact support immediately.',
    type: 'security',
    severity: 'warning',
    metadata: { action: 'pin_changed' }
  });
} catch (e) {
  console.warn('PIN changed notify failed', e);
}

    return res.json({
      status: true,
      message: 'PIN changed successfully'
    });
  } catch (err) {
    console.error('❌ withdrawController.changePin ERROR:', err);
    return res
      .status(500)
      .json({ status: false, message: 'PIN change failed' });
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
  const { pin } = req.body || {};

  console.log('withdrawController.verifyPin › user:', userId);

  try {
    if (!pin) {
      return res.status(400).json({
        status: false,
        message: 'PIN required'
      });
    }

    const match = await bcrypt.compare(
      String(pin),
      String(user.transaction_pin_hash)
    );
    if (!match) {
      return res
        .status(400)
        .json({ status: false, message: 'Invalid PIN' });
    }

    return res.json({
      status: true,
      message: 'PIN verified'
    });
  } catch (err) {
    console.error('❌ withdrawController.verifyPin ERROR:', err);
    return res
      .status(500)
      .json({ status: false, message: 'Could not verify PIN' });
  }
}

/**
 * ---------------------------------------------------------
 * REQUEST PIN RESET (user provides password)
 * ---------------------------------------------------------
 *//**
/**
 * ---------------------------------------------------------
 * REQUEST PIN RESET (EMAIL OTP ONLY)
 * ---------------------------------------------------------
 */
async function requestPinReset(req, res) {
  const user = req.user;
  const userId = user.id;
  const { password } = req.body || {};

  console.log('withdrawController.requestPinReset › user:', userId);

  try {
    // 1️⃣ Validate input
    if (!password) {
      return res.status(400).json({
        status: false,
        message: 'Password is required'
      });
    }

    // 2️⃣ Fetch password + existing OTP expiry
    const [rows] = await pool.query(
      `SELECT password_hash, pin_reset_otp_expiry
       FROM users
       WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        status: false,
        message: 'User not found'
      });
    }

    const { password_hash, pin_reset_otp_expiry } = rows[0];

    if (!password_hash) {
      return res.status(400).json({
        status: false,
        message: 'Password not set for this account'
      });
    }

    // 3️⃣ Verify password
    const ok = await bcrypt.compare(String(password), String(password_hash));
    if (!ok) {
      return res.status(400).json({
        status: false,
        message: 'Incorrect password'
      });
    }

    // 🚫 4️⃣ BLOCK MULTIPLE ACTIVE OTPs (THIS WAS THE BUG)
    if (
      pin_reset_otp_expiry &&
      new Date() < new Date(pin_reset_otp_expiry)
    ) {
      return res.status(400).json({
        status: false,
        message: 'An OTP was already sent. Please check your email.'
      });
    }

    // 5️⃣ Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000);
    const otpHash = await bcrypt.hash(String(otp), 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    // 6️⃣ Persist OTP (CRITICAL)
    await pool.query(
      `UPDATE users
       SET pin_reset_otp_hash = ?, pin_reset_otp_expiry = ?
       WHERE id = ? LIMIT 1`,
      [otpHash, expiresAt, userId]
    );

    // ✅ 7️⃣ RESPOND IMMEDIATELY (UI NEVER FAILS)
    res.json({
      status: true,
      message: 'PIN reset OTP sent to your email'
    });

    // -------------------------------------------------
    // 🔔 8️⃣ FIRE-AND-FORGET (EMAIL + NOTIFY)
    // -------------------------------------------------
    setImmediate(async () => {
      // 📧 EMAIL (OTP ONLY HERE)
      try {
        await sendEmail(
          user.email,
          'Trebetta PIN Reset OTP',
          `
            <p>You requested to reset your transaction PIN.</p>
            <p><strong>Your OTP is: ${otp}</strong></p>
            <p>This code expires in 10 minutes.</p>
            <p>If this wasn’t you, contact Trebetta support immediately.</p>
          `
        );
      } catch (e) {
        console.warn('PIN reset OTP email failed (ignored):', e?.message);
      }

      // 🔔 In-app notification (NO OTP)
      try {
        await notify({
          userId,
          email: null,
          title: 'PIN Reset Requested',
          message: 'A PIN reset was requested. Check your email for the OTP.',
          type: 'security',
          severity: 'warning',
          metadata: {
            action: 'pin_reset_requested',
            expires_at: expiresAt.toISOString()
          }
        });
      } catch (e) {
        console.warn('PIN reset notify failed (ignored):', e?.message);
      }

      // 🧾 Audit log (best effort)
      try {
        await auditLog(
          null,
          userId,
          'PIN_RESET_REQUESTED',
          'users',
          userId,
          {}
        );
      } catch {}
    });

  } catch (err) {
    console.error('❌ requestPinReset ERROR:', err);
    return res.status(500).json({
      status: false,
      message: 'Could not request PIN reset'
    });
  }
}


/**
 * ---------------------------------------------------------
 * RESET TRANSACTION PIN (OTP + new PIN)
 * ---------------------------------------------------------
 */
async function resetPin(req, res) {
  const user = req.user;
  const userId = user.id;
  const { otp, new_pin } = req.body || {};

  console.log('withdrawController.resetPin › user:', userId);

  try {
    if (!otp || !new_pin) {
      return res.status(400).json({
        status: false,
        message: 'OTP and new PIN are required'
      });
    }

    if (String(new_pin).length < 4) {
      return res.status(400).json({
        status: false,
        message: 'New PIN must be at least 4 digits'
      });
    }

    const [rows] = await pool.query(
      `SELECT pin_reset_otp_hash, pin_reset_otp_expiry
       FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ status: false, message: 'User not found' });
    }

    const { pin_reset_otp_hash, pin_reset_otp_expiry } = rows[0];

    if (!pin_reset_otp_hash || !pin_reset_otp_expiry) {
      return res.status(400).json({
        status: false,
        message: 'No active OTP found. Request PIN reset again.'
      });
    }

    const expiryDate = new Date(pin_reset_otp_expiry);
    if (new Date() > expiryDate) {
      return res.status(400).json({
        status: false,
        message: 'OTP expired. Request a new one.'
      });
    }

    const match = await bcrypt.compare(
      String(otp),
      String(pin_reset_otp_hash)
    );
    if (!match) {
      return res
        .status(400)
        .json({ status: false, message: 'Invalid OTP' });
    }

    const hashed = await bcrypt.hash(String(new_pin), 10);

    await pool.query(
      `UPDATE users
       SET transaction_pin_hash = ?, 
           pin_reset_otp_hash = NULL,
           pin_reset_otp_expiry = NULL
       WHERE id = ? LIMIT 1`,
      [hashed, userId]
    );

    await auditLog(
      null,
      userId,
      'PIN_RESET_COMPLETED',
      'transaction_pin',
      null,
      { message: 'PIN reset successfully' }
    );
try {
  await auditLog(
    null,
    userId,
    'PIN_RESET_COMPLETED',
    'users',
    userId, // ✅ NEVER NULL
    { action: 'pin_reset_completed' }
  );
} catch (e) {
  console.warn('PIN_RESET_COMPLETED auditLog failed:', e.message);
}


    return res.json({
      status: true,
      message: 'Transaction PIN reset successfully'
    });
  } catch (err) {
    console.error('❌ resetPin ERROR:', err);
    return res
      .status(500)
      .json({ status: false, message: 'Could not reset PIN' });
  }
}

/**
 * ---------------------------------------------------------
 * ADD SAVED ACCOUNT (manual)
 * POST /wallet/accounts
 * Body: { bank_code, account_number, account_name }
 * ---------------------------------------------------------
 */
async function addSavedAccount(req, res) {
  const userId = req.user.id;
  const { bank_code, account_number, account_name } = req.body || {};

  console.log('withdrawController.addSavedAccount › user:', userId);

  try {
    if (!bank_code || !account_number || !account_name) {
      return res.status(400).json({
        status: false,
        message: 'bank_code, account_number and account_name are required'
      });
    }

    const code = String(bank_code).trim();
    const accNo = String(account_number).trim();
    const accName = String(account_name).trim();

    await pool.query(
      `INSERT INTO saved_accounts (user_id, bank_code, account_number, account_name, created_at)
       SELECT ?, ?, ?, ?, NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM saved_accounts
         WHERE user_id = ? AND bank_code = ? AND account_number = ?
       )`,
      [userId, code, accNo, accName, userId, code, accNo]
    );

    await auditLog(
      null,
      userId,
      'SAVED_ACCOUNT_ADDED',
      'saved_accounts',
      null,
      { bank_code: code, account_number: accNo }
    );

    return res.json({
      status: true,
      message: 'Bank account saved successfully'
    });
  } catch (err) {
    console.error('❌ addSavedAccount ERROR:', err);
    return res
      .status(500)
      .json({ status: false, message: 'Could not save bank account' });
  }
}

/**
 * ---------------------------------------------------------
 * DELETE SAVED ACCOUNT
 * DELETE /wallet/accounts/:id
 * ---------------------------------------------------------
 */
async function deleteSavedAccount(req, res) {
  const userId = req.user.id;
  const id = Number(req.params.id);

  console.log('withdrawController.deleteSavedAccount › user:', userId, 'id:', id);

  try {
    if (!id) {
      return res
        .status(400)
        .json({ status: false, message: 'Invalid account id' });
    }

    const [rows] = await pool.query(
      `SELECT id, bank_code, account_number 
       FROM saved_accounts 
       WHERE id = ? AND user_id = ? LIMIT 1`,
      [id, userId]
    );

    if (!rows.length) {
      return res
        .status(404)
        .json({ status: false, message: 'Saved account not found' });
    }

    const acc = rows[0];

    await pool.query(
      `DELETE FROM saved_accounts WHERE id = ? AND user_id = ?`,
      [id, userId]
    );

    await auditLog(
      null,
      userId,
      'SAVED_ACCOUNT_DELETED',
      'saved_accounts',
      id,
      { bank_code: acc.bank_code, account_number: acc.account_number }
    );

    return res.json({
      status: true,
      message: 'Saved account deleted successfully'
    });
  } catch (err) {
    console.error('❌ deleteSavedAccount ERROR:', err);
    return res
      .status(500)
      .json({ status: false, message: 'Could not delete bank account' });
  }
}

module.exports = {
  initiateWithdraw,
  confirmWithdraw,
  createPin,
  changePin,
  verifyPin,
  requestPinReset,
  resetPin,
  addSavedAccount,
  deleteSavedAccount
};
