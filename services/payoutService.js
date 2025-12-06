// src/services/payoutService.js
const pool = require('../config/db');
const { queue } = require('../config/bullmq');
const walletService = require('./walletService');
const { sendInApp, sendEmail } = require('../utils/notify');
const { addToRollover } = require('../utils/rolloverHelper');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');
const winnerTickerService = require('../services/winnerTickerService');
const slipService = require('../services/slipService');
const { getSystemSetting } = require('../services/settingsService'); // <-- NEW

// Mask usernames for ticker + slips
function maskUsername(username = '') {
  if (!username) return 'User***';
  if (username.length <= 2) return `${username[0]}*`;
  return `${username.slice(0, 3)}***`;
}

// Create settlement job record
async function updateSettlementJob(connOrPool, jobId, updates = {}) {
  const fields = [];
  const params = [];

  if (updates.status) { fields.push('status = ?'); params.push(updates.status); }
  if (typeof updates.attempts !== 'undefined') { fields.push('attempts = ?'); params.push(updates.attempts); }
  if (updates.last_error) { fields.push('last_error = ?'); params.push(updates.last_error); }

  params.push(jobId);

  if (!fields.length) return;

  const sql = `
    UPDATE pool_settlement_jobs 
    SET ${fields.join(', ')}, updated_at = NOW()
    WHERE job_id = ?
  `;
  return connOrPool.query(sql, params);
}

module.exports = {

  // ---------------------------------------------
  // QUEUE JOB
  // ---------------------------------------------
  async queueSettlement(poolId, winningOptionId, initiatedBy = null) {
    try {
      const jobId = `settlement-${poolId}-${Date.now()}`;

      await pool.query(
        `INSERT INTO pool_settlement_jobs (pool_id, job_id, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'queued', 0, NOW(), NOW())`,
        [poolId, jobId]
      );

      await queue.add(
        'settlement',
        { poolId, winningOptionId, initiatedBy, jobId },
        {
          jobId,
          removeOnComplete: true,
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 }
        }
      );

      logger.info(`Queued settlement job ${jobId} for pool ${poolId}`);
      return { success: true, jobId };

    } catch (err) {
      logger.error('queueSettlement error', err);
      throw err;
    }
  },

  // ---------------------------------------------
  // SETTLE POOL
  // ---------------------------------------------
  async settlePool(poolId, winningOptionId, initiatedBy = null, jobId = null) {
    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();
      logger.info(`Starting settlement for pool ${poolId} (winningOption: ${winningOptionId})`);

      // Lock pool
      const [[poolRow]] = await conn.query(`SELECT * FROM pools WHERE id = ? FOR UPDATE`, [poolId]);
      if (!poolRow) throw new Error('Pool not found');

      if (poolRow.status === 'settled') {
        if (jobId) await updateSettlementJob(pool, jobId, { status: 'completed' });
        await conn.commit();
        return { success: true, message: 'Already settled' };
      }

      // Winning option fetch
      let winningOption = null;

      if (winningOptionId) {
        const [optRows] = await conn.query(
          `SELECT * FROM pool_options WHERE id = ? AND pool_id = ?`,
          [winningOptionId, poolId]
        );
        if (!optRows.length) throw new Error('Winning option not found');
        winningOption = optRows[0];
      }

      let winningEntries = [];

      if (winningOption) {
        const [we] = await conn.query(
          `SELECT * FROM pool_entries 
           WHERE pool_id = ? AND option_id = ? AND status IN ('joined','active')`,
          [poolId, winningOptionId]
        );
        winningEntries = we;
      }

      // ------------------------------------------------------
      // 🌟 COMPANY CUT — FINAL LOGIC
      // 1. Prefer poolRow.company_cut_percent
      // 2. Else use system setting company_cut_percent
      // ------------------------------------------------------
      let companyCutPercent = poolRow.company_cut_percent;

      if (
        companyCutPercent === null ||
        companyCutPercent === undefined ||
        Number.isNaN(Number(companyCutPercent))
      ) {
        companyCutPercent = await getSystemSetting('company_cut_percent');
      }

      companyCutPercent = Number(companyCutPercent || 0);

      const totalStake = Number(poolRow.total_stake || poolRow.total_pool_amount || 0);
      const companyCut = (companyCutPercent / 100) * totalStake;
      const payoutPool = Number((totalStake - companyCut).toFixed(2));

      // ------------------------------------------------------
      // CASE 1 — NO WINNERS → ROLLOVER FLOW
      // ------------------------------------------------------
      if (!winningOption || winningEntries.length === 0) {
        // Create pool_loss slips for every participant
        try {
          const [entries] = await conn.query(
            `SELECT pe.user_id, pe.amount, u.username, po.title AS option_title
             FROM pool_entries pe
             LEFT JOIN users u ON u.id = pe.user_id
             LEFT JOIN pool_options po ON po.id = pe.option_id
             WHERE pe.pool_id = ?`,
            [poolId]
          );

          for (const e of entries) {
            await slipService.createSlip(e.user_id, 'pool_loss', {
              pool_title: poolRow.title,
              option_title: e.option_title,
              stake: Number(e.amount),
              lost: true,
              user_masked: maskUsername(e.username),
              pool_type: poolRow.type,
              reason: 'no_winner_rollover',
              created_at: new Date().toISOString()
            });
          }
        } catch (err) {
          logger.warn('Slip creation (no winner) failed', err);
        }

        // Add payoutPool to rollover stash
        if (payoutPool > 0) {
          await addToRollover(conn, payoutPool);
        }

        // Insert ledger
        await conn.query(
          `INSERT INTO pool_ledger 
             (pool_id, total_pool, company_cut, payout_pool, total_winners, total_payouts, settled_at, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, NOW())`,
          [
            poolId,
            totalStake,
            companyCut,
            payoutPool,
            0,
            0,
            JSON.stringify({ note: 'No winners — rollover applied' })
          ]
        );

        await conn.query(`UPDATE pools SET status = 'rollover' WHERE id = ?`, [poolId]);

        if (jobId) await updateSettlementJob(pool, jobId, { status: 'completed' });
        await conn.commit();
        return { success: true, message: 'Rollover applied (no winners)' };
      }

      // ------------------------------------------------------
      // CASE 2 — WINNERS EXIST → PAYOUT FLOW
      // ------------------------------------------------------
      const totalWinningStake = winningEntries.reduce(
        (sum, e) => sum + Number(e.amount || 0),
        0
      );

      if (!totalWinningStake) throw new Error('Invalid winning stake total');

      let totalPayouts = 0;
      let winnersCount = 0;

      for (const entry of winningEntries) {
        const entryAmt = Number(entry.amount);
        const ratio = entryAmt / totalWinningStake;
        const userShare = Number((ratio * payoutPool).toFixed(2));

        const txnRef = `POOLP-${poolId}-${uuidv4().slice(0, 8).toUpperCase()}`;

        // Credit wallet
        await walletService.creditUserWallet(
          conn,
          entry.user_id,
          userShare,
          `Pool ${poolId} winnings`,
          {
            type: 'pool_payout',
            gateway: 'internal',
            reference: txnRef,
            description: `Pool payout`
          }
        );

        // Mark entry as won
        await conn.query(
          `UPDATE pool_entries SET status = 'won' WHERE id = ?`,
          [entry.id]
        );

        // Insert payout record
        await conn.query(
          `INSERT INTO pool_payouts 
             (pool_id, entry_id, user_id, amount, txn_ref, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'completed', NOW(), NOW())`,
          [poolId, entry.id, entry.user_id, userShare, txnRef]
        );

        // Create slip
        try {
          const [[poolInfo]] = await conn.query(
            `SELECT title, type FROM pools WHERE id = ? LIMIT 1`,
            [poolId]
          );
          const [[optInfo]] = await conn.query(
            `SELECT title FROM pool_options WHERE id = ? LIMIT 1`,
            [entry.option_id]
          );
          const [[uRow]] = await conn.query(
            `SELECT username FROM users WHERE id = ?`,
            [entry.user_id]
          );

          await slipService.createSlip(entry.user_id, 'pool_win', {
            pool_title: poolInfo.title,
            option_title: optInfo.title,
            stake: entryAmt,
            amount_won: userShare,
            user_masked: maskUsername(uRow?.username),
            pool_type: poolInfo.type,
            created_at: new Date().toISOString()
          });

          // Winner ticker
          await winnerTickerService.addWinner({
            user_id: entry.user_id,
            pool_id: poolId,
            amount_won: userShare,
            source: 'auto',
            message: `${maskUsername(uRow?.username)} won ₦${userShare} in ${poolInfo.title}`
          });
        } catch (err) {
          logger.warn('Winner slip/ticker fail', err);
        }

        // Notify user
        try {
          await sendInApp(entry.user_id, 'You won!', `You won ₦${userShare} from pool ${poolRow.title}`);
          await sendEmail(entry.user_id, 'You won!', `₦${userShare} has been credited to your wallet.`);
        } catch (err) {
          logger.warn('Winner notification fail', err);
        }

        totalPayouts += userShare;
        winnersCount++;
      }

      // Create loss slips for losers
      try {
        const [losers] = await conn.query(
          `SELECT pe.user_id, pe.amount, u.username, po.title AS option_title
           FROM pool_entries pe
           LEFT JOIN users u ON u.id = pe.user_id
           LEFT JOIN pool_options po ON po.id = pe.option_id
           WHERE pe.pool_id = ? AND pe.option_id != ?`,
          [poolId, winningOptionId]
        );

        for (const e of losers) {
          await slipService.createSlip(e.user_id, 'pool_loss', {
            pool_title: poolRow.title,
            option_title: e.option_title,
            stake: Number(e.amount),
            lost: true,
            user_masked: maskUsername(e.username),
            pool_type: poolRow.type,
            reason: 'lost_to_winner',
            created_at: new Date().toISOString()
          });
        }
      } catch (err) {
        logger.warn('loss slip fail', err);
      }

      // Update option statuses
      await conn.query(
        `UPDATE pool_options SET status = 'eliminated' WHERE pool_id = ? AND id != ?`,
        [poolId, winningOptionId]
      );
      await conn.query(
        `UPDATE pool_options SET status = 'active' WHERE pool_id = ? AND id = ?`,
        [poolId, winningOptionId]
      );

      // Insert ledger
      await conn.query(
        `INSERT INTO pool_ledger 
           (pool_id, total_pool, company_cut, payout_pool, total_winners, total_payouts, settled_at, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, NOW())`,
        [
          poolId,
          totalStake,
          companyCut,
          payoutPool,
          winnersCount,
          totalPayouts,
          JSON.stringify({ winners: winnersCount })
        ]
      );

      // Mark pool settled
      await conn.query(
        `UPDATE pools SET status = 'settled' WHERE id = ?`,
        [poolId]
      );

      if (jobId) await updateSettlementJob(pool, jobId, { status: 'completed' });

      await conn.commit();

      logger.info(
        `Pool ${poolId} settled → ₦${totalPayouts} paid to ${winnersCount} winners`
      );

      return { success: true, totalPayouts, winnersCount };

    } catch (err) {
      try {
        if (jobId) {
          await updateSettlementJob(pool, jobId, {
            status: 'failed',
            last_error: err.message
          });
        }
      } catch (_) {}

      try { await conn.rollback(); } catch (_) {}
      logger.error('settlePool error', err);
      throw err;

    } finally {
      try { conn.release(); } catch (_) {}
    }
  }
};
