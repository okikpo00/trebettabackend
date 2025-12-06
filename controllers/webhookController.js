// controllers/webhookController.js
const pool = require('../config/db');
const { FLW_SECRET_HASH } = require('../config/flutterwave');
const { PAYSTACK_WEBHOOK_SECRET } = require('../config/paystack');
const slipService = require('../services/slipService');
const walletService = require('../services/walletService');
const auditLog = require('../utils/auditLog');
const { tryInsertWebhook } = require('../utils/idempotency');
const { verifyPaystackSignature } = require('../utils/signatureVerifier');


// ---------------------------------------------------------
// FLUTTERWAVE WEBHOOK (DEPOSITS)
// ---------------------------------------------------------
async function flutterwaveWebhook(req, res) {
  // req.body is RAW BUFFER because of bodyParser.raw
  const rawBody = req.body;
  const signature = req.headers['verif-hash'];

  console.log('[WEBHOOK][FLW] Received webhook');

  try {
    if (!FLW_SECRET_HASH) {
      console.warn('[WEBHOOK][FLW] FLW_SECRET_HASH not set. Cannot verify webhook signature.');
      return res.status(403).send('Signature not configured');
    }

    if (!signature || signature !== FLW_SECRET_HASH) {
      console.warn('[WEBHOOK][FLW] Invalid signature header');
      return res.status(403).send('Invalid signature');
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    console.log('[WEBHOOK][FLW] Parsed payload:', JSON.stringify(payload, null, 2));

    const event = payload.event;
    const txRef = payload.data?.tx_ref || payload.data?.txRef || payload.data?.reference;

    if (!txRef) {
      console.warn('[WEBHOOK][FLW] Missing tx_ref in payload');
      return res.send('ok');
    }

    // Only process relevant event
    if (event !== 'charge.completed') {
      console.log('[WEBHOOK][FLW] Ignoring event:', event);
      return res.send('ok');
    }

    // Idempotency
    const inserted = await tryInsertWebhook(
      'flutterwave',
      txRef,
      event,
      payload,
      signature
    );

    if (!inserted) {
      console.log('[WEBHOOK][FLW] Duplicate webhook for reference:', txRef);
      return res.send('ok');
    }

    // Find pending transaction
    const [txRows] = await pool.query(
      `SELECT * FROM transactions WHERE reference = ? LIMIT 1`,
      [txRef]
    );

    if (!txRows.length) {
      console.warn('[WEBHOOK][FLW] No transaction found for reference:', txRef);
      return res.send('ok');
    }

    const tx = txRows[0];

    if (tx.status === 'completed') {
      console.log('[WEBHOOK][FLW] Transaction already completed for ref:', txRef);
      return res.send('ok');
    }

    const userId = tx.user_id;
    const amount = tx.amount;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Credit wallet using walletService
      await walletService.creditUserWallet(conn, userId, amount, 'deposit');

      // Update transaction
      await conn.query(
        `UPDATE transactions
         SET status = 'completed',
             metadata = ?
         WHERE id = ?`,
        [JSON.stringify(payload), tx.id]
      );

      // after walletService.creditUserWallet(...) and tx status = 'completed'
try {
  const [[userRow]] = await pool.query(
    'SELECT username FROM users WHERE id = ? LIMIT 1',
    [userId]
  );

  const payload = {
    amount: Number(amount),
    provider: flutterwave, // e.g. 'flutterwave' or 'paystack'
    currency: 'NGN',
    reference: txRef,       // your internal reference
    user_masked: (userRow?.username ? (userRow.username.length <= 2
      ? `${userRow.username[0]}*`
      : `${userRow.username.slice(0, 3)}***`) : 'user'),
    created_at: new Date().toISOString()
  };

  await slipService.createSlip(userId, 'deposit', payload);
} catch (e) {
  logger && logger.warn && logger.warn('Deposit webhook createSlip deposit failed', e);
}


      await auditLog(
        userId,
        'deposit_completed',
        `Deposit of ₦${amount} confirmed via Flutterwave`,
        { reference: txRef, provider: 'flutterwave' }
      );

      await conn.commit();
      conn.release();
    } catch (txErr) {
      console.error('[WEBHOOK][FLW] DB TX ERROR:', txErr);
      await conn.rollback();
      conn.release();
    }

    return res.send('ok');
  } catch (err) {
    console.error('❌ [WEBHOOK][FLW] ERROR:', err);
    return res.send('ok');
  }
}


// ---------------------------------------------------------
// PAYSTACK WEBHOOK (DEPOSITS)
// ---------------------------------------------------------
async function paystackWebhook(req, res) {
  const rawBody = req.body; // Buffer
  console.log('[WEBHOOK][PAYSTACK] Received webhook');

  try {
    if (!PAYSTACK_WEBHOOK_SECRET) {
      console.warn('[WEBHOOK][PAYSTACK] PAYSTACK_WEBHOOK_SECRET not set.');
      return res.status(403).send('Signature not configured');
    }

    const signatureHeader = req.headers['x-paystack-signature'];
    const validSig = verifyPaystackSignature(rawBody, signatureHeader, PAYSTACK_WEBHOOK_SECRET);

    if (!validSig) {
      console.warn('[WEBHOOK][PAYSTACK] Invalid signature');
      return res.status(403).send('Invalid signature');
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    console.log('[WEBHOOK][PAYSTACK] Parsed payload:', JSON.stringify(payload, null, 2));

    const event = payload.event;
    if (event !== 'charge.success') {
      console.log('[WEBHOOK][PAYSTACK] Ignoring event:', event);
      return res.send('ok');
    }

    const reference = payload.data?.reference;
    if (!reference) {
      console.warn('[WEBHOOK][PAYSTACK] Missing reference in payload');
      return res.send('ok');
    }

    // Idempotency
    const inserted = await tryInsertWebhook(
      'paystack',
      reference,
      event,
      payload,
      signatureHeader
    );

    if (!inserted) {
      console.log('[WEBHOOK][PAYSTACK] Duplicate webhook for reference:', reference);
      return res.send('ok');
    }

    // Find pending transaction
    const [txRows] = await pool.query(
      `SELECT * FROM transactions WHERE reference = ? LIMIT 1`,
      [reference]
    );

    if (!txRows.length) {
      console.warn('[WEBHOOK][PAYSTACK] No transaction found for reference:', reference);
      return res.send('ok');
    }

    const tx = txRows[0];

    if (tx.status === 'completed') {
      console.log('[WEBHOOK][PAYSTACK] Transaction already completed for ref:', reference);
      return res.send('ok');
    }

    const userId = tx.user_id;
    const amount = tx.amount;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await walletService.creditUserWallet(conn, userId, amount, 'deposit');

      await conn.query(
        `UPDATE transactions
         SET status = 'completed',
             metadata = ?
         WHERE id = ?`,
        [JSON.stringify(payload), tx.id]
      );

      await auditLog(
        userId,
        'deposit_completed',
        `Deposit of ₦${amount} confirmed via Paystack`,
        { reference, provider: 'paystack' }
      );

      await conn.commit();
      conn.release();
    } catch (txErr) {
      console.error('[WEBHOOK][PAYSTACK] DB TX ERROR:', txErr);
      await conn.rollback();
      conn.release();
    }

    return res.send('ok');
  } catch (err) {
    console.error('❌ [WEBHOOK][PAYSTACK] ERROR:', err);
    return res.send('ok');
  }
}

module.exports = {
  flutterwaveWebhook,
  paystackWebhook
};
