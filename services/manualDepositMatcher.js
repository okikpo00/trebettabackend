const pool = require('../config/db');
const logger = require('../utils/logger');
const walletService = require('./walletService');
const slipService = require('./slipService');

async function runManualDepositMatcher() {
  try {
    // 1. Fetch latest bank alerts NOT matched yet
    const [alerts] = await pool.query(
      `SELECT * FROM incoming_bank_alerts 
       WHERE status = 'new'
       ORDER BY tx_time DESC
       LIMIT 20`
    );

    if (!alerts.length) return;

    for (const alert of alerts) {
      const amount = Number(alert.amount);

      // 2. Try match with pending deposits
      const [pending] = await pool.query(
        `SELECT * FROM pending_deposits
         WHERE amount = ?
           AND status = 'pending'
           AND expires_at >= NOW()
         ORDER BY created_at ASC
         LIMIT 1`,
        [amount]
      );

      if (!pending.length) {
        // No pending deposit with this exact amount
        await pool.query(
          `UPDATE incoming_bank_alerts 
           SET status = 'ignored'
           WHERE id = ?`,
          [alert.id]
        );
        continue;
      }

      const p = pending[0];

      // 3. Credit user wallet
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        await walletService.creditUserWallet(
          conn,
          p.user_id,
          p.amount,
          "manual_deposit",
          {
            reference: p.reference,
            bank: "Sterling",
            sender_name: alert.sender_name
          }
        );

        // Mark pending deposit as matched
        await conn.query(
          `UPDATE pending_deposits
           SET status = 'matched',
               matched_alert_id = ?
           WHERE id = ?`,
          [alert.id, p.id]
        );

        // Mark alert as matched
        await conn.query(
          `UPDATE incoming_bank_alerts
           SET status = 'matched'
           WHERE id = ?`,
          [alert.id]
        );

        await slipService.createSlip(
          p.user_id,
          "deposit",
          {
            amount: p.amount,
            reference: p.reference,
            sender_name: alert.sender_name,
            credited_by: "manual-engine"
          }
        );

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        logger.error("manualDepositMatcher error:", err);
      } finally {
        conn.release();
      }

      // OPTIONAL: Notify user + admin
      // sendPush(...)
    }
  } catch (err) {
    logger.error("manualDepositMatcher fatal:", err);
  }
}

module.exports = { runManualDepositMatcher };
