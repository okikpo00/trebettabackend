// controllers/depositController.js
const pool = require('../config/db');
const generateReference = require('../utils/generateReference');
const { auditLog } = require('../utils/auditLog');

// OLD: const { MIN_DEPOSIT } = require('../utils/limits');
// NEW: dynamic system settings
const { getSystemSetting } = require('../services/settingsService');

const { createFlutterwaveTransfer } = require('../services/flutterwaveBankService');
const { createPaystackTransfer } = require('../services/paystackBankService');


// ---------------------------------------------------------
// INITIATE WALLET DEPOSIT
// ---------------------------------------------------------
async function initiateDeposit(req, res) {
  const userId = req.user.id;
  const { amount } = req.body;

  console.log(
    'depositController.initiateDeposit › user:',
    userId,
    'amount:',
    amount
  );

  try {
    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      return res.status(400).json({ status: false, message: 'Invalid deposit amount' });
    }

    // ----------------------------------------
    // ️🔍 LOAD MIN DEPOSIT FROM SYSTEM SETTINGS
    // ----------------------------------------
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

    // Ensure wallet exists
    const [walletRows] = await pool.query(
      'SELECT id FROM wallets WHERE user_id = ? LIMIT 1',
      [userId]
    );

    if (!walletRows.length) {
      console.warn('depositController.initiateDeposit › wallet not found:', userId);
      return res.status(400).json({ status: false, message: 'Wallet not found' });
    }

    const walletId = walletRows[0].id;
    const reference = generateReference('DEP');

    let provider = 'flutterwave';
    let bankDetails = null;

    // Try flutterwave
    try {
      bankDetails = await createFlutterwaveTransfer(
        req.user,
        parsedAmount,
        reference
      );
      provider = 'flutterwave';
    } catch (err) {
      console.error(
        'Flutterwave failed → trying Paystack:',
        err.response?.data || err.message || err
      );

      // Fallback
      try {
        bankDetails = await createPaystackTransfer(
          req.user,
          parsedAmount,
          reference
        );
        provider = 'paystack';
      } catch (err2) {
        console.error(
          'Paystack fallback also failed:',
          err2.response?.data || err2.message || err2
        );
        return res.status(502).json({
          status: false,
          message: 'Unable to generate deposit account at the moment. Please try again.'
        });
      }
    }

    // Insert pending transaction
    const [result] = await pool.query(
      `INSERT INTO transactions
        (wallet_id, user_id, type, amount, provider, status, reference, metadata, created_at, updated_at)
       VALUES (?, ?, 'deposit', ?, ?, 'pending', ?, ?, NOW(), NOW())`,
      [
        walletId,
        userId,
        parsedAmount,
        provider,
        reference,
        JSON.stringify({
          bank_details: bankDetails,
          provider
        })
      ]
    );

    console.log(
      `depositController.initiateDeposit › txn id: ${result.insertId}, provider: ${provider}`
    );

    await auditLog(
      userId,
      'deposit_initiated',
      `Deposit initiated for ₦${parsedAmount} via ${provider}`,
      {
        reference,
        amount: parsedAmount,
        provider
      }
    );

    return res.json({
      status: true,
      message: 'Deposit initiated. Transfer to the provided account to fund your wallet.',
      data: {
        reference,
        provider,
        bank: {
          bank_name: bankDetails.bank_name,
          account_number: bankDetails.account_number,
          account_name: bankDetails.account_name,
          expires_at: bankDetails.expires_at
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

module.exports = {
  initiateDeposit
};
