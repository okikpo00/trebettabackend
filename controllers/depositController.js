// controllers/depositController.js
const pool = require('../config/db');
const generateReference = require('../utils/generateReference');
const { auditLog } = require('../utils/auditLog');
const { getSystemSetting } = require('../services/settingsService');

// STATIC BANK DETAILS FOR MANUAL DEPOSIT
// ⚠️ Make sure these match your Sterling business account exactly
const TREBETTA_BANK = {
  bank_name: 'STERLING BANK',
  account_name: 'HORIZON BLUE BLISS GLOBAL',
  account_number: '0116012103' // e.g. '00612340089'
};

// How long a pending deposit stays valid (in minutes)
const PENDING_EXPIRES_MIN = 15;

// ---------------------------------------------------------
// INITIATE WALLET DEPOSIT  (MANUAL / SEMI-AUTO VERSION)
// ---------------------------------------------------------
async function initiateDeposit(req, res) {
  const userId = req.user.id;
  const { amount, sender_name, sender_bank } = req.body || {};

  console.log('depositController.initiateDeposit ›', {
    userId,
    amount,
    sender_name,
    sender_bank
  });

  try {
    const parsedAmount = Number(amount);

    // basic amount validation
    if (!parsedAmount || parsedAmount <= 0) {
      return res
        .status(400)
        .json({ status: false, message: 'Invalid deposit amount' });
    }

    // validate sender_name
    if (!sender_name || String(sender_name).trim().length < 2) {
      return res
        .status(400)
        .json({ status: false, message: 'Sender account name is required' });
    }

    // validate sender_bank
    if (!sender_bank || String(sender_bank).trim().length < 2) {
      return res
        .status(400)
        .json({ status: false, message: 'Sender bank is required' });
    }

    const cleanSenderName = String(sender_name).trim();
    const cleanSenderBank = String(sender_bank).trim();

    // 1) Load min_deposit from system_settings
    const minDeposit = Number(await getSystemSetting('min_deposit')) || 100;

    if (parsedAmount < minDeposit) {
      console.warn(
        `depositController.initiateDeposit › amount ${parsedAmount} < min_deposit ${minDeposit}`
      );
      return res.status(400).json({
        status: false,
        message: `Minimum deposit is ₦${minDeposit}`
      });
    }

    // 2) Ensure wallet exists
    const [walletRows] = await pool.query(
      'SELECT id FROM wallets WHERE user_id = ? LIMIT 1',
      [userId]
    );

    if (!walletRows.length) {
      console.warn(
        'depositController.initiateDeposit › wallet not found for user:',
        userId
      );
      return res
        .status(400)
        .json({ status: false, message: 'Wallet not found' });
    }

    const walletId = walletRows[0].id;

    // 3) Generate unique reference (for SMS matching + admin UI)
    const reference = generateReference('DEP'); // e.g. DEP_...

    // 4) Compute expiry (now + 15 min)
    const expiresAt = new Date(Date.now() + PENDING_EXPIRES_MIN * 60 * 1000);

    // 5) Insert into pending_deposits (NOT transactions yet)
    const [ins] = await pool.query(
      `
        INSERT INTO pending_deposits
          (user_id, wallet_id, amount, sender_name, sender_bank, reference, status, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NOW(), NOW())
      `,
      [
        userId,
        walletId,
        parsedAmount,
        cleanSenderName,
        cleanSenderBank,
        reference,
        expiresAt
      ]
    );

    console.log(
      'depositController.initiateDeposit › pending_deposits.id:',
      ins.insertId
    );

    // 6) Audit log
    try {
      await auditLog(
        null, // adminId (null – user initiated)
        userId,
        'MANUAL_DEPOSIT_INITIATED',
        'pending_deposits',
        ins.insertId,
        {
          amount: parsedAmount,
          reference,
          sender_name: cleanSenderName,
          sender_bank: cleanSenderBank,
          expires_at: expiresAt.toISOString()
        }
      );
    } catch (aErr) {
      console.warn(
        'depositController.initiateDeposit › auditLog failed',
        aErr
      );
    }

    // 7) Respond to frontend
    return res.json({
      status: true,
      message: `Deposit created. Transfer the exact amount to the bank account within ${PENDING_EXPIRES_MIN} minutes.`,
      data: {
        reference,
        amount: parsedAmount,
        expires_at: expiresAt.toISOString(),
        sender_name: cleanSenderName,
        sender_bank: cleanSenderBank,
        bank: {
          bank_name: TREBETTA_BANK.bank_name,
          account_number: TREBETTA_BANK.account_number,
          account_name: TREBETTA_BANK.account_name
        }
      }
    });
  } catch (err) {
    console.error('❌ depositController.initiateDeposit ERROR:', err);
    return res.status(500).json({
      status: false,
      message: 'Something went wrong while initiating deposit'
    });
  }
}

// ---------------------------------------------------------
// GET MOST RECENT ACTIVE PENDING DEPOSIT
// ---------------------------------------------------------
async function getPendingDeposit(req, res) {
  const userId = req.user.id;

  try {
    // Fetch latest active pending deposit
    const [rows] = await pool.query(
      `
      SELECT 
        id, reference, amount, sender_name, sender_bank, expires_at, status
      FROM pending_deposits
      WHERE user_id = ?
        AND status = 'pending'
        AND expires_at > NOW()
      ORDER BY id DESC
      LIMIT 1
      `,
      [userId]
    );

    if (!rows.length) {
      return res.json({
        status: true,
        data: null
      });
    }

    const dep = rows[0];

    // Same bank info used in initiateDeposit()
    const TREBETTA_BANK = {
      bank_name: 'STERLING BANK',
      account_name: 'HORIZON BLUE BLISS GLOBAL',
      account_number: '0116012103'
    };

    return res.json({
      status: true,
      data: {
        reference: dep.reference,
        amount: Number(dep.amount),
        expires_at: dep.expires_at,
        sender_name: dep.sender_name || null,
        sender_bank: dep.sender_bank || null,
        bank: TREBETTA_BANK
      }
    });

  } catch (err) {
    console.error('❌ getPendingDeposit ERROR:', err);
    return res.status(500).json({
      status: false,
      message: 'Failed to load pending deposit'
    });
  }
}

module.exports = {
  initiateDeposit,
  getPendingDeposit
};


