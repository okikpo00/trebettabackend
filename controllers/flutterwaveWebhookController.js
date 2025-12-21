const pool = require('../config/db');
const walletService = require('../services/walletService');
const slipService = require('../services/slipService');
const { auditLog } = require('../utils/auditLog');
const notify = require('../utils/notify');
const { tryInsertWebhook } = require('../utils/idempotency');

const { FLW_SECRET_HASH } = process.env;

/**
 * ---------------------------------------------------------
 * FLUTTERWAVE WEBHOOK
 * ---------------------------------------------------------
 */
async function flutterwaveWebhook(req, res) {
  const signature = req.headers['verif-hash'];

  console.log('[FLW][WEBHOOK] received');

  try {
    // -------------------------------------------------
    // Verify signature
    // -------------------------------------------------
    if (!signature || signature !== FLW_SECRET_HASH) {
      console.warn('[FLW][WEBHOOK] invalid signature');
      return res.status(403).send('Invalid signature');
    }

    // -------------------------------------------------
    // SAFELY PARSE PAYLOAD (BUFFER OR OBJECT)
    // -------------------------------------------------
    let payload;
    try {
      if (Buffer.isBuffer(req.body)) {
        payload = JSON.parse(req.body.toString('utf8'));
      } else {
        payload = req.body;
      }
    } catch (e) {
      console.error('[FLW][WEBHOOK] payload parse failed', e.message);
      return res.send('ok');
    }

    console.log('[FLW][WEBHOOK] event:', payload?.event);

    // -------------------------------------------------
    // Only handle successful charges
    // -------------------------------------------------
    if (payload.event !== 'charge.completed') {
      return res.send('ok');
    }

    const txRef = payload.data?.tx_ref;
    if (!txRef) {
      console.warn('[FLW][WEBHOOK] missing tx_ref');
      return res.send('ok');
    }

    // -------------------------------------------------
    // Idempotency check
    // -------------------------------------------------
    const { inserted } = await tryInsertWebhook(
      'flutterwave',
      txRef,
      payload.event,
      payload,
      signature
    );

    if (!inserted) {
      console.log('[FLW][WEBHOOK] duplicate ignored:', txRef);
      return res.send('ok');
    }

    // -------------------------------------------------
    // Load transaction
    // -------------------------------------------------
    const [[tx]] = await pool.query(
      'SELECT * FROM transactions WHERE reference = ? LIMIT 1',
      [txRef]
    );

    if (!tx) {
      console.warn('[FLW][WEBHOOK] transaction not found:', txRef);
      return res.send('ok');
    }

    if (tx.status === 'completed') {
      console.log('[FLW][WEBHOOK] already completed:', txRef);
      return res.send('ok');
    }

    // -------------------------------------------------
    // CREDIT WALLET (TRANSACTIONAL)
    // -------------------------------------------------
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await walletService.creditUserWallet(
        conn,
        tx.user_id,
        tx.amount,
        'deposit',
        {
          type: 'deposit',
          gateway: 'flutterwave',
          reference: tx.reference,
          description: 'Flutterwave wallet deposit'
        }
      );

      await conn.query(
        `UPDATE transactions
         SET status = 'completed', metadata = ?
         WHERE id = ?`,
        [JSON.stringify(payload), tx.id]
      );

      // -------------------------------------------------
      // Deposit slip (best-effort)
      // -------------------------------------------------
      try {
        await slipService.createSlip(tx.user_id, 'deposit', {
          amount: Number(tx.amount),
          provider: 'flutterwave',
          reference: tx.reference,
          created_at: new Date().toISOString()
        });
      } catch (e) {
        console.warn('[FLW][WEBHOOK] slip failed:', e.message);
      }

      await auditLog(
        null,
        tx.user_id,
        'FLW_DEPOSIT_COMPLETED',
        'transactions',
        tx.id,
        { reference: tx.reference }
      );

      await conn.commit();

      // -------------------------------------------------
      // Notify user (post-commit)
      // -------------------------------------------------
      try {
        const [[user]] = await pool.query(
          'SELECT email FROM users WHERE id = ? LIMIT 1',
          [tx.user_id]
        );

        if (user?.email) {
          await notify({
            userId: tx.user_id,
            email: user.email,
            title: 'Deposit Successful',
            message: `Your deposit of ₦${Number(tx.amount).toLocaleString()} was successful.`,
            type: 'deposit',
            severity: 'success'
          });
        }
      } catch {
        console.warn('[FLW][WEBHOOK] notify failed');
      }

      console.log('[FLW][WEBHOOK] deposit completed:', tx.reference);
    } catch (txErr) {
      await conn.rollback();
      console.error('[FLW][WEBHOOK] TX ERROR:', txErr.message);
    } finally {
      conn.release();
    }

    return res.send('ok');
  } catch (err) {
    console.error('[FLW][WEBHOOK] ERROR:', err.message);
    return res.send('ok');
  }
}

module.exports = {
  flutterwaveWebhook
};
