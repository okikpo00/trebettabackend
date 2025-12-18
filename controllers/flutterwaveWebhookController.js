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
  const rawBody = req.body;
  const signature = req.headers['verif-hash'];

  console.log('[FLW][WEBHOOK] received');

  try {
    if (!signature || signature !== FLW_SECRET_HASH) {
      console.warn('[FLW][WEBHOOK] invalid signature');
      return res.status(403).send('Invalid signature');
    }

    const payload = JSON.parse(rawBody.toString('utf8'));
    console.log('[FLW][WEBHOOK] payload:', payload.event);

    if (payload.event !== 'charge.completed') {
      return res.send('ok');
    }

    const txRef = payload.data?.tx_ref;
    if (!txRef) return res.send('ok');

    const { inserted } = await tryInsertWebhook(
      'flutterwave',
      txRef,
      payload.event,
      payload,
      signature
    );

    if (!inserted) {
      console.log('[FLW][WEBHOOK] duplicate:', txRef);
      return res.send('ok');
    }

    const [[tx]] = await pool.query(
      `SELECT * FROM transactions WHERE reference = ? LIMIT 1`,
      [txRef]
    );

    if (!tx || tx.status === 'completed') {
      console.log('[FLW][WEBHOOK] already handled');
      return res.send('ok');
    }

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

      // slip
      try {
        await slipService.createSlip(tx.user_id, 'deposit', {
          amount: Number(tx.amount),
          provider: 'flutterwave',
          reference: tx.reference,
          created_at: new Date().toISOString()
        });
      } catch (e) {
        console.warn('[FLW][WEBHOOK] slip failed', e.message);
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

      // notify (post commit)
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
      } catch (nErr) {
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
