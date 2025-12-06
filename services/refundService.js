// src/services/refundService.js
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const walletService = require('./walletService');
const logger = require('../utils/logger'); // expects { info, warn, error }
const slipService = require('./slipService'); // for pool_refund slips
const notify = require('../utils/notify');   // in-app notification (object style)

/**
 * Refund entries for a pool (partial or full)
 *
 * @param {Object} opts
 * @param {number} opts.poolId
 * @param {number[]|null} opts.entryIds - array of entry ids to refund.
 *        if null => refund all 'joined'/'active' entries for pool
 * @param {number} opts.adminId - admin performing the action (for audit)
 * @param {string} opts.reason - refund reason (optional)
 *
 * Returns:
 *  {
 *    refundedCount,
 *    totalRefunded,
 *    entries: [ { entryId, userId, amount, txnRef } ],
 *    message?: string
 *  }
 */
async function refundPoolEntries({ poolId, entryIds = null, adminId = null, reason = null }) {
  const conn = await pool.getConnection();
  const results = { refundedCount: 0, totalRefunded: 0, entries: [] };

  try {
    await conn.beginTransaction();

    // 1) fetch pool for sanity + slip payload
    const [[poolRow]] = await conn.query(
      'SELECT id, title, status, total_pool_amount, total_stake, type FROM pools WHERE id = ? LIMIT 1',
      [poolId]
    );
    if (!poolRow) {
      throw new Error('Pool not found');
    }

    // 2) determine which entries to refund
    let entriesSql = `
      SELECT *
      FROM pool_entries
      WHERE pool_id = ?
        AND status IN ("joined","active")
    `;
    const params = [poolId];

    if (Array.isArray(entryIds) && entryIds.length) {
      // protect against SQL injection by using placeholders
      const placeholders = entryIds.map(() => '?').join(',');
      entriesSql += ` AND id IN (${placeholders})`;
      params.push(...entryIds);
    }

    const [entries] = await conn.query(entriesSql, params);

    if (!entries.length) {
      // nothing to refund
      await conn.rollback();
      return { ...results, message: 'No refundable entries found' };
    }

    // 3) process each refundable entry
    for (const e of entries) {
      const amount = parseFloat(e.amount || 0);
      if (amount <= 0) {
        logger && logger.warn && logger.warn(`Skipping zero-amount entry ${e.id}`);
        continue;
      }

      // create txn ref (for trace + pool_payouts)
      const txnRef = `RF_${uuidv4().slice(0, 8).toUpperCase()}`;

      // 3a) Credit user wallet — try (conn, userId, amount, reason, ref) first, fallback to (userId,...)
      try {
        if (typeof walletService.creditUserWallet !== 'function') {
          throw new Error('walletService.creditUserWallet not available');
        }

        let credited = false;
        const desc = `Refund: ${reason || `Pool ${poolId}`}`;

        try {
          // common signature: (conn, userId, amount, reason, ref)
          await walletService.creditUserWallet(conn, e.user_id, amount, desc, txnRef);
          credited = true;
        } catch (innerErr) {
          // fallback: (userId, amount, reason, ref)
          await walletService.creditUserWallet(e.user_id, amount, desc, txnRef);
          credited = true;
        }

        if (!credited) {
          throw new Error('Wallet credit failed for refund');
        }
      } catch (creditErr) {
        logger && logger.error && logger.error('Failed to credit wallet for refund', {
          entryId: e.id,
          userId: e.user_id,
          amount,
          err: creditErr
        });
        // fail the whole operation (we want refund to be atomic)
        throw new Error(`Failed to credit wallet for user ${e.user_id}`);
      }

      // 3b) mark entry as refunded
      await conn.query(
        'UPDATE pool_entries SET status = ?, updated_at = NOW() WHERE id = ?',
        ['refunded', e.id]
      );

      // 3c) create REFUND SLIP (best-effort — does NOT break transaction if it fails)
      try {
        // Fetch option + user for slip payload
        const [[optInfo]] = await conn.query(
          'SELECT title FROM pool_options WHERE id = ? LIMIT 1',
          [e.option_id]
        );

        const [[userRow]] = await conn.query(
          'SELECT username FROM users WHERE id = ? LIMIT 1',
          [e.user_id]
        );

        const username = userRow?.username || '';
        let masked;
        if (!username) {
          masked = 'user';
        } else if (username.length <= 2) {
          masked = `${username[0]}*`;
        } else {
          masked = `${username.slice(0, 3)}***`;
        }

        await slipService.createSlip(e.user_id, 'pool_refund', {
          pool_title: poolRow?.title || `Pool #${poolId}`,
          option_title: optInfo?.title || null,
          stake: amount,
          refunded: true,
          user_masked: masked,
          pool_type: poolRow?.type || null,
          created_at: new Date().toISOString(),
          reason: reason || null,
          entry_reference: e.reference || null
        });

        // in-app notification (best-effort)
        try {
          await notify({
            user_id: e.user_id,
            title: 'Pool refund processed',
            message: `You have been refunded ₦${amount.toFixed(2)} for pool "${poolRow.title || `#${poolId}`}".`,
            metadata: { pool_id: poolId, entry_id: e.id, amount }
          });
        } catch (nErr) {
          logger && logger.warn && logger.warn('refundPoolEntries notify failed', nErr);
        }
      } catch (slipErr) {
        // Don't break refund flow because of slip/notify
        logger && logger.warn && logger.warn('refundPoolEntries slip creation failed', slipErr);
      }

      // 3d) insert a pool_payouts record as a trace for the refund (use status completed)
      await conn.query(
        `INSERT INTO pool_payouts
         (pool_id, entry_id, user_id, amount, txn_ref, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [poolId, e.id, e.user_id, amount, txnRef, 'completed']
      );

      // 3e) adjust pool totals (reducing total_pool_amount and total_stake)
      await conn.query(
        'UPDATE pools SET total_pool_amount = total_pool_amount - ?, total_stake = total_stake - ? WHERE id = ?',
        [amount, amount, poolId]
      );

      // accumulate result
      results.refundedCount += 1;
      results.totalRefunded += amount;
      results.entries.push({ entryId: e.id, userId: e.user_id, amount, txnRef });
    }

    // 4) if we refunded all entries in pool, optionally set pool status
    const [left] = await conn.query(
      'SELECT COUNT(*) AS cnt FROM pool_entries WHERE pool_id = ? AND status IN ("joined","active")',
      [poolId]
    );
    const remaining = left[0]?.cnt || 0;
    if (remaining === 0) {
      // mark pool as 'refunded' so UI knows it's refunded
      await conn.query('UPDATE pools SET status = ? WHERE id = ?', ['refunded', poolId]);
    }

    // 5) audit_log (non-blocking — failure here will not rollback refunds)
    try {
      if (adminId) {
        await conn.query(
          'INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)',
          [
            adminId,
            'POOL_REFUND',
            'pool',
            poolId,
            JSON.stringify({
              refundedCount: results.refundedCount,
              totalRefunded: results.totalRefunded,
              reason,
              partial: remaining > 0
            })
          ]
        );
      }
    } catch (auditErr) {
      logger && logger.warn && logger.warn('Failed to write audit log for refund', auditErr);
      // do not fail the whole operation for an audit log failure
    }

    await conn.commit();
    logger &&
      logger.info &&
      logger.info(`Refund completed for pool ${poolId}`, {
        refundedCount: results.refundedCount,
        totalRefunded: results.totalRefunded
      });

    return results;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    logger && logger.error && logger.error('refundPoolEntries error', err);
    throw err;
  } finally {
    try {
      conn.release();
    } catch (_) {
      // ignore
    }
  }
}

module.exports = { refundPoolEntries };
