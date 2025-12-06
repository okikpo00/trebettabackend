// src/services/poolService.js
const pool = require('../config/db');
const idempotency = require('../utils/idempotency');
const cache = require('../utils/cache');
const { v4: uuidv4 } = require('uuid');
const rolloverHelper = require('../utils/rolloverHelper');
const { debitUserWallet } = require('./walletService');
const winmeter = require('./winmeterService');
const logger = require('../utils/logger');
const { getSystemSetting } = require('./settingsService');

const MIN_PULSE = Number(process.env.MIN_ENTRY_PULSE || 500);
const MIN_GRAND = Number(process.env.MIN_ENTRY_GRAND || 1000);

/**
 * List open pools (basic, for admin)
 */
async function listOpenPools({ type = null, page = 1, limit = 20 } = {}) {
  const offset = (page - 1) * limit;
  let sql = `
    SELECT p.*, IFNULL(w.participant_count,0) AS participants
    FROM pools p
    LEFT JOIN pool_participants_summary w ON w.pool_id = p.id
    WHERE p.status = "open"
  `;
  const params = [];

  if (type) {
    sql += ' AND p.type = ?';
    params.push(type);
  }

  sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const [rows] = await pool.query(sql, params);
  return rows;
}

/**
 * Get single pool with options
 */
async function getPoolById(poolId) {
  const [[p]] = await pool.query('SELECT * FROM pools WHERE id = ? LIMIT 1', [poolId]);
  if (!p) return null;

  const [options] = await pool.query(
    'SELECT * FROM pool_options WHERE pool_id = ? ORDER BY id',
    [poolId]
  );

  return { ...p, options };
}

/**
 * Create a pool
 *
 * includeRollover:
 *  - if true, we pull FULL rollover balance into this pool's total_pool_amount
 *  - and consume it from rollover_pool_balance
 */
async function createPool({
  title,
  description,
  type = 'pulse',
  min_entry = null,
  closing_date,
  created_by,
  includeRollover = false
}) {
  console.log('poolService.createPool ›', {
    title,
    type,
    min_entry,
    closing_date,
    created_by,
    includeRollover
  });

  const minEntry = min_entry || (type === 'pulse' ? MIN_PULSE : MIN_GRAND);

  let rolloverAmount = 0;

  if (includeRollover) {
    try {
      const { amount } = await rolloverHelper.getRolloverBalance();
      rolloverAmount = Number(amount || 0);
    } catch (e) {
      logger && logger.warn && logger.warn('createPool › getRolloverBalance failed', e);
    }
  }

  const [res] = await pool.query(
    `
      INSERT INTO pools 
        (title, description, type, min_entry, closing_date, created_by, status, total_pool_amount, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NOW())
    `,
    [title, description, type, minEntry, closing_date, created_by, rolloverAmount]
  );

  const poolId = res.insertId;

  if (includeRollover && rolloverAmount > 0) {
    try {
      await rolloverHelper.consumeFromRollover(pool, rolloverAmount);
    } catch (e) {
      logger && logger.error && logger.error('createPool › consumeFromRollover failed', e);
      // we do NOT rollback pool creation – admin can correct manually if needed
    }
  }

  return {
    id: poolId,
    rollover_included: includeRollover,
    rollover_amount: rolloverAmount
  };
}

/**
 * Add an option to a pool
 */
async function addOption(poolId, title, metadata = {}) {
  const [res] = await pool.query(
    'INSERT INTO pool_options (pool_id, title, metadata, created_at) VALUES (?, ?, ?, NOW())',
    [poolId, title, JSON.stringify(metadata)]
  );
  return { id: res.insertId };
}

/**
 * Join pool:
 *  - idempotent by reference
 *  - debits wallet
 *  - inserts entry
 *  - updates option + pool totals + participant summary
 */
async function joinPool({ userId, poolId, optionId, amount, reference }) {
  if (!reference) {
    reference = `POOLENTRY-${Date.now()}-${uuidv4().slice(0, 8)}`;
  }

  console.log('poolService.joinPool ›', {
    userId,
    poolId,
    optionId,
    amount,
    reference
  });

  await idempotency.ensureUnique(reference, 'pool_entries');

  const [[pRow]] = await pool.query(
    'SELECT id, status, min_entry FROM pools WHERE id = ? LIMIT 1',
    [poolId]
  );

  if (!pRow) throw new Error('pool_not_found');
  if (pRow.status !== 'open') throw new Error('pool_not_open');
  if (Number(amount) < Number(pRow.min_entry)) throw new Error('amount_below_min');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // debit user wallet (uses transactions.type = 'pool_entry' now via options in walletService)
    const { walletId } = await debitUserWallet(
      conn,
      userId,
      amount,
      `Join pool ${poolId}`,
      {
        type: 'pool_entry',
        gateway: 'internal',
        description: `Pool #${poolId} entry`
      }
    );

    const [ins] = await conn.query(
      `
        INSERT INTO pool_entries 
          (pool_id, option_id, user_id, wallet_id, amount, reference, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
      `,
      [poolId, optionId, userId, walletId, amount, reference]
    );

    await conn.query(
      'UPDATE pool_options SET total_stake = total_stake + ? WHERE id = ?',
      [amount, optionId]
    );

    await conn.query(
      `
        UPDATE pools 
        SET total_pool_amount = total_pool_amount + ?, 
            total_stake = total_stake + ? 
        WHERE id = ?
      `,
      [amount, amount, poolId]
    );

    await conn.query(
      `
        INSERT INTO pool_participants_summary 
          (pool_id, participant_count, total_stake, updated_at) 
        VALUES (?, 1, ?, NOW())
        ON DUPLICATE KEY UPDATE 
          participant_count = participant_count + 1,
          total_stake = total_stake + ?,
          updated_at = NOW()
      `,
      [poolId, amount, amount]
    );

    await conn.commit();

    // invalidate per-pool cache and winmeter
    try {
      await cache.del(`pool:${poolId}`);
    } catch (e) {
      logger && logger.warn && logger.warn('joinPool › cache.del failed', e);
    }
    try {
      await winmeter.invalidateWinmeter(poolId);
    } catch (e) {
      logger && logger.warn && logger.warn('joinPool › winmeter.invalidateWinmeter failed', e);
    }

    return { entryId: ins.insertId, reference };
  } catch (e) {
    await conn.rollback();
    console.error('poolService.joinPool error:', e);
    throw e;
  } finally {
    conn.release();
  }
}

/**
 * Lock pool
 */
async function lockPool(poolId) {
  console.log('poolService.lockPool ›', { poolId });
  await pool.query(
    'UPDATE pools SET status = "locked" WHERE id = ? AND status = "open"',
    [poolId]
  );
  await cache.del(`pool:${poolId}`);
  return { success: true };
}

/**
 * Close pool
 */
async function closePool(poolId) {
  console.log('poolService.closePool ›', { poolId });
  await pool.query(
    'UPDATE pools SET status = "closed" WHERE id = ? AND status IN ("open","locked")',
    [poolId]
  );
  await cache.del(`pool:${poolId}`);
  return { success: true };
}

/**
 * List pools by status (admin list)
 */
async function listPoolsByStatus({ status = null, page = 1, limit = 20 } = {}) {
  const safePage = Number(page) || 1;
  const safeLimit = Number(limit) || 20;
  const offset = (safePage - 1) * safeLimit;

  let sql = `
    SELECT 
      p.*, 
      IFNULL(w.participant_count, 0) AS participants
    FROM pools p
    LEFT JOIN pool_participants_summary w ON w.pool_id = p.id
  `;

  const params = [];

  if (status) {
    sql += ' WHERE p.status = ?';
    params.push(status);
  }

  sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
  params.push(safeLimit, offset);

  console.log('listPoolsByStatus SQL:', pool.format(sql, params));
  const [rows] = await pool.query(sql, params);
  return rows;
}

/**
 * Fetch participants for a pool (admin)
 */
async function fetchPoolParticipants(poolId) {
  const [rows] = await pool.query(
    `
      SELECT 
        e.id AS entry_id, 
        e.user_id, 
        u.username, 
        e.amount, 
        e.created_at,
        o.title AS option_title, 
        e.status
      FROM pool_entries e
      JOIN users u ON e.user_id = u.id
      JOIN pool_options o ON e.option_id = o.id
      WHERE e.pool_id = ?
      ORDER BY e.created_at DESC
    `,
    [poolId]
  );
  return rows;
}

/**
 * Update pool details (title, description, closing_date) while open
 */
async function updatePoolDetails(poolId, updates) {
  const allowed = ['title', 'description', 'closing_date'];
  const fields = [];
  const values = [];

  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(updates, key) && updates[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(updates[key]);
    }
  }

  if (!fields.length) {
    return { message: 'No valid fields to update' };
  }

  values.push(poolId);

  const sql = `
    UPDATE pools 
    SET ${fields.join(', ')} 
    WHERE id = ? AND status = "open"
  `;

  console.log('poolService.updatePoolDetails › SQL:', pool.format(sql, values));

  const [r] = await pool.query(sql, values);
  return { affected: r.affectedRows };
}

/**
 * Get full pool ledger:
 *  - pool summary
 *  - company cut & payout pool (from ledger if exists, else computed)
 *  - options with totals
 *  - entries (all for admin, or user-only for user)
 *  - payouts attached to entries
 *  - cached for settled pools
 */
async function getPoolLedger(poolId, userId = null, isAdmin = false) {
  if (!poolId) throw new Error('Invalid pool id');

  const cacheKey = `ledger:pool:${poolId}`;

  try {
    const cached = await cache.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);

      if (isAdmin) {
        return { ...parsed, cached: true };
      }

      // for normal user, filter entries + add user_total_participation
      parsed.options = parsed.options.map((opt) => {
        opt.entries = (opt.entries || []).filter(
          (e) => Number(e.user_id) === Number(userId)
        );
        return opt;
      });

      parsed.summary.user_total_participation = parsed.options.reduce(
        (s, o) =>
          s +
          o.entries.reduce((se, ee) => se + Number(ee.amount || 0), 0),
        0
      );

      return { ...parsed, cached: true };
    }

    const [[poolRow]] = await pool.query(
      'SELECT * FROM pools WHERE id = ? LIMIT 1',
      [poolId]
    );
    if (!poolRow) throw new Error('Pool not found');

    const [ledgerRows] = await pool.query(
      'SELECT * FROM pool_ledger WHERE pool_id = ? LIMIT 1',
      [poolId]
    );
    const ledgerRow = ledgerRows[0] || null;

    const totalStake = Number(poolRow.total_stake || 0);
    let companyCut = null;
    let payoutPool = null;
    let totalWinners = null;
    let totalPayouts = null;

    if (ledgerRow) {
      companyCut = Number(ledgerRow.company_cut || 0);
      payoutPool = Number(
        ledgerRow.payout_pool ||
          ledgerRow.total_pool - companyCut ||
          0
      );
      totalWinners = Number(ledgerRow.total_winners || 0);
      totalPayouts = Number(ledgerRow.total_payouts || 0);
    } else {
      // Use poolRow.company_cut_percent if set, else global system setting
      const globalCut =
        Number(await getSystemSetting('company_cut_percent')) || 10;

      const cutPct = Number(
        poolRow.company_cut_percent || globalCut
      );

      companyCut = (cutPct / 100) * totalStake;
      payoutPool = totalStake - companyCut;
    }

    const [optionsRows] = await pool.query(
      `
        SELECT
          po.id,
          po.title,
          po.status,
          COALESCE(SUM(pe.amount), 0) AS option_total,
          COUNT(DISTINCT CASE WHEN pe.user_id IS NOT NULL THEN pe.user_id END) AS participants_count
        FROM pool_options po
        LEFT JOIN pool_entries pe ON pe.option_id = po.id
        WHERE po.pool_id = ?
        GROUP BY po.id
        ORDER BY po.id
      `,
      [poolId]
    );

    const optionIds = optionsRows.map((r) => r.id);
    let entriesMap = {};

    if (optionIds.length) {
      let entriesSql = `
        SELECT 
          pe.id, 
          pe.option_id, 
          pe.user_id, 
          pe.amount, 
          pe.status, 
          pe.reference, 
          pe.created_at,
          u.username, 
          u.email
        FROM pool_entries pe
        LEFT JOIN users u ON u.id = pe.user_id
        WHERE pe.pool_id = ?
      `;
      const entriesParams = [poolId];

      if (!isAdmin && userId) {
        entriesSql += ' AND pe.user_id = ?';
        entriesParams.push(userId);
      }

      entriesSql += ' ORDER BY pe.created_at DESC';

      const [entriesRows] = await pool.query(entriesSql, entriesParams);

      entriesMap = entriesRows.reduce((acc, er) => {
        const optId = er.option_id;
        if (!acc[optId]) acc[optId] = [];
        acc[optId].push({
          id: er.id,
          option_id: er.option_id,
          user_id: er.user_id,
          username: er.username || null,
          amount: Number(er.amount || 0),
          status: er.status,
          reference: er.reference,
          created_at: er.created_at,
          payout_amount: null,
          txn_ref: null
        });
        return acc;
      }, {});
    }

    const [payoutRows] = await pool.query(
      'SELECT entry_id, amount, txn_ref, status FROM pool_payouts WHERE pool_id = ?',
      [poolId]
    );
    const payoutMap = payoutRows.reduce((m, p) => {
      m[p.entry_id] = p;
      return m;
    }, {});

    for (const optId of Object.keys(entriesMap)) {
      entriesMap[optId] = entriesMap[optId].map((e) => {
        const p = payoutMap[e.id];
        if (p) {
          e.payout_amount = Number(p.amount || 0);
          e.txn_ref = p.txn_ref || null;
          e.payout_status = p.status;
        }
        return e;
      });
    }

    const options = optionsRows.map((or) => ({
      id: or.id,
      title: or.title,
      status: or.status,
      option_total: Number(or.option_total || 0),
      participants_count: Number(or.participants_count || 0),
      entries: entriesMap[or.id] || []
    }));

    const [participantsCountRows] = await pool.query(
      'SELECT COUNT(DISTINCT user_id) AS cnt FROM pool_entries WHERE pool_id = ?',
      [poolId]
    );
    const totalParticipants = participantsCountRows?.[0]?.cnt || 0;

    const result = {
      pool: {
        id: poolRow.id,
        title: poolRow.title,
        type: poolRow.type,
        status: poolRow.status,
        min_entry: Number(poolRow.min_entry || 0),
        created_at: poolRow.created_at,
        closing_date: poolRow.closing_date
      },
      ledger: ledgerRow
        ? {
            id: ledgerRow.id,
            total_pool: Number(ledgerRow.total_pool || totalStake),
            company_cut: Number(ledgerRow.company_cut || companyCut),
            payout_pool: Number(ledgerRow.payout_pool || payoutPool),
            total_winners: Number(ledgerRow.total_winners || totalWinners || 0),
            total_payouts: Number(ledgerRow.total_payouts || totalPayouts || 0),
            settled_at: ledgerRow?.settled_at || null,
            details: (() => {
              try {
                if (!ledgerRow?.details) return null;
                return typeof ledgerRow.details === 'string'
                  ? JSON.parse(ledgerRow.details)
                  : ledgerRow.details;
              } catch {
                return ledgerRow.details || null;
              }
            })()
          }
        : null,
      summary: {
        total_pool: Number(totalStake),
        company_cut: Number(companyCut),
        payout_pool: Number(payoutPool),
        total_participants: Number(totalParticipants),
        total_options: options.length
      },
      options
    };

    // Cache for settled pools
    if (poolRow.status === 'settled') {
      try {
        await cache.set(cacheKey, JSON.stringify(result), 60 * 10);
      } catch (cErr) {
        logger && logger.warn && logger.warn('Failed to set ledger cache', cErr);
      }
    }

    // User-specific summary
    if (!isAdmin && userId) {
      result.summary.user_total_participation = result.options.reduce(
        (s, o) =>
          s +
          o.entries.reduce((se, ee) => se + Number(ee.amount || 0), 0),
        0
      );
    }

    return result;
  } catch (err) {
    logger && logger.error && logger.error('getPoolLedger error', err);
    throw err;
  }
}

module.exports = {
  listOpenPools,
  getPoolById,
  createPool,
  addOption,
  joinPool,
  lockPool,
  closePool,
  listPoolsByStatus,
  fetchPoolParticipants,
  updatePoolDetails,
  getPoolLedger
};
