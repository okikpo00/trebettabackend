const axios = require('axios');
const pool = require('../config/db');
const generateReference = require('../utils/generateReference');
const { auditLog } = require('../utils/auditLog');
const notify = require('../utils/notify');

const {
  FLW_SECRET_KEY,
  FLW_BASE_URL,
  FLW_REDIRECT_URL
} = process.env;

/**
 * ---------------------------------------------------------
 * INITIATE FLUTTERWAVE DEPOSIT (REDIRECT FLOW)
 * ---------------------------------------------------------
 */
async function initiateFlutterwaveDeposit(req, res) {
  const userId = req.user.id;
  const { amount } = req.body || {};

  console.log('[FLW][INIT] user:', userId, 'amount:', amount);

  try {
    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      console.warn('[FLW][INIT] invalid amount:', amount);
      return res.status(400).json({
        status: false,
        message: 'Invalid deposit amount'
      });
    }

    if (!FLW_REDIRECT_URL) {
      console.error('[FLW][INIT] FLW_REDIRECT_URL not set');
      return res.status(500).json({
        status: false,
        message: 'Payment redirect not configured'
      });
    }

    // -------------------------------------------------
    // Load user
    // -------------------------------------------------
    const [[user]] = await pool.query(
      'SELECT id, email, username FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    if (!user) {
      return res.status(404).json({
        status: false,
        message: 'User not found'
      });
    }

    // -------------------------------------------------
    // Load wallet
    // -------------------------------------------------
    const [[wallet]] = await pool.query(
      'SELECT id FROM wallets WHERE user_id = ? LIMIT 1',
      [userId]
    );

    if (!wallet) {
      return res.status(400).json({
        status: false,
        message: 'Wallet not found'
      });
    }

    // -------------------------------------------------
    // Create internal reference
    // -------------------------------------------------
    const reference = generateReference('FLW');

    // -------------------------------------------------
    // Create pending transaction (DO NOT credit wallet)
    // -------------------------------------------------
    await pool.query(
      `INSERT INTO transactions
        (wallet_id, user_id, type, amount, gateway, status, reference, created_at)
       VALUES (?, ?, 'deposit', ?, 'flutterwave', 'pending', ?, NOW())`,
      [wallet.id, userId, parsedAmount, reference]
    );

    console.log('[FLW][INIT] transaction created:', reference);

    // -------------------------------------------------
    // Call Flutterwave
    // -------------------------------------------------
    const payload = {
      tx_ref: reference,
      amount: parsedAmount,
      currency: 'NGN',
      redirect_url: FLW_REDIRECT_URL,
      payment_options: 'card,banktransfer,ussd',
      customer: {
        email: user.email,
        name: user.username || 'Trebetta User'
      },
      customizations: {
        title: 'Trebetta Wallet Deposit',
        description: 'Wallet funding'
      }
    };

    console.log('[FLW][INIT] sending payload:', payload);

    const flwRes = await axios.post(
      `${FLW_BASE_URL}/payments`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 20000
      }
    );

    const paymentLink = flwRes?.data?.data?.link;

    if (!paymentLink) {
      console.error('[FLW][INIT] no payment link returned:', flwRes.data);
      return res.status(500).json({
        status: false,
        message: 'Failed to get payment link'
      });
    }

    console.log('[FLW][INIT] payment link created');

    // -------------------------------------------------
    // Audit log (non-blocking)
    // -------------------------------------------------
    try {
      await auditLog(
        null,
        userId,
        'FLW_DEPOSIT_INITIATED',
        'transactions',
        reference,
        { amount: parsedAmount }
      );
    } catch (e) {
      console.warn('[FLW][INIT] auditLog failed', e.message);
    }

    // -------------------------------------------------
    // Notify user (best-effort)
    // -------------------------------------------------
    try {
      await notify({
        userId,
        email: user.email,
        title: 'Complete Your Deposit',
        message: `Click the link below to complete your ₦${parsedAmount.toLocaleString()} deposit.`,
        type: 'deposit',
        severity: 'info',
        metadata: { reference, amount: parsedAmount }
      });
    } catch (nErr) {
      console.warn('[FLW][INIT] notify failed', nErr.message);
    }

    // -------------------------------------------------
    // Respond to frontend
    // -------------------------------------------------
    return res.json({
      status: true,
      data: {
        reference,
        payment_link: paymentLink
      }
    });

  } catch (err) {
    console.error(
      '[FLW][INIT] ERROR:',
      err?.response?.data || err.message
    );

    return res.status(500).json({
      status: false,
      message: 'Failed to initiate Flutterwave deposit'
    });
  }
}

module.exports = {
  initiateFlutterwaveDeposit
};
