// controllers/walletController.js
const pool = require('../config/db');
const { getSettingsCached } = require('../services/settingsService');

// ---------------------------------------------------------
// GET WALLET BALANCE
// ---------------------------------------------------------
async function getWallet(req, res) {
  console.log('[WALLET] getWallet › user:', req.user.id);

  try {
    const [rows] = await pool.query(
      `SELECT id, user_id, balance, reserved_balance, currency, status, created_at, updated_at
       FROM wallets WHERE user_id = ? LIMIT 1`,
      [req.user.id]
    );

    if (!rows.length) {
      console.log('[WALLET] getWallet › wallet not found for user:', req.user.id);
      return res.status(404).json({ status: false, message: 'Wallet not found' });
    }

    return res.json({ status: true, wallet: rows[0] });

  } catch (err) {
    console.error('[WALLET] ERROR getWallet:', err);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
}


// ---------------------------------------------------------
// GET TRANSACTION HISTORY
// ---------------------------------------------------------
async function getTransactions(req, res) {
  console.log('[WALLET] getTransactions › user:', req.user.id);

  const page = Number(req.query.page || 1);
  const limit = Number(req.query.limit || 50);
  const offset = (page - 1) * limit;

  try {
    const [rows] = await pool.query(
      `SELECT 
          id, user_id, type, amount, provider, reference, status,
          metadata, balance_before, balance_after, created_at
       FROM transactions
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [req.user.id, limit, offset]
    );

    return res.json({
      status: true,
      data: rows,
      meta: { page, limit }
    });

  } catch (err) {
    console.error('[WALLET] ERROR getTransactions:', err);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
}


// ---------------------------------------------------------
// GET SAVED BANK ACCOUNTS
// ---------------------------------------------------------
async function getSavedAccounts(req, res) {
  console.log('[WALLET] getSavedAccounts › user:', req.user.id);

  try {
    const [rows] = await pool.query(
      `SELECT id, bank_code, account_number, account_name, created_at
       FROM saved_accounts
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    // Mask account numbers for response
    rows.forEach(r => {
      if (r.account_number) {
        r.account_number = r.account_number
          .slice(-4)
          .padStart(r.account_number.length, '*');
      }
    });

    return res.json({ status: true, data: rows });

  } catch (err) {
    console.error('[WALLET] ERROR getSavedAccounts:', err);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
}


// ---------------------------------------------------------
// NEW: GET WITHDRAWAL FEE RULES
// ---------------------------------------------------------
async function getWithdrawalFees(req, res) {
  console.log('[WALLET] getWithdrawalFees');

  try {
    const settings = await getSettingsCached();
    let rules = settings.withdraw_fee_rules;

    // Parse JSON if needed
    if (typeof rules === 'string') {
      try {
        rules = JSON.parse(rules);
      } catch (err) {
        console.warn('[WALLET] invalid withdraw_fee_rules JSON:', err);
        rules = [];
      }
    }

    // Ensure it's always an array
    if (!Array.isArray(rules)) {
      rules = [];
    }

    return res.json({
      status: true,
      data: rules
    });

  } catch (err) {
    console.error('[WALLET] ERROR getWithdrawalFees:', err);
    return res.status(500).json({
      status: false,
      message: 'Failed to load withdrawal fees'
    });
  }
}



// ---------------------------------------------------------
// EXPORT CONTROLLER FUNCTIONS
// ---------------------------------------------------------
module.exports = {
  getWallet,
  getTransactions,
  getSavedAccounts,
  getWithdrawalFees
};
