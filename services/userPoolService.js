// src/services/userPoolService.js
const pool = require('../config/db');
const cache = require('../utils/cache');
const idempotency = require('../utils/idempotency');
const winmeter = require('./winmeterService');
const walletService = require('./walletService');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const slipService = require('../services/slipService');


const POOLS_OPEN_CACHE_KEY = 'pools:open';
const POOLS_OPEN_TTL = 30; // seconds

function maskUsername(u) {
  if (!u) return 'user';
  if (u.length <= 2) return `${u[0]}*`;
  return `${u.slice(0, 3)}***`;
}

/**
 * listPools - open pools for homepage (cached)
*/

const TARGET_PULSE = Number(process.env.TARGET_PULSE || 500000);
const TARGET_GRAND = Number(process.env.TARGET_GRAND || 1000000);

/**
 * listPools - open + locked pools for homepage (cached)
 */
async function listPools({ type = null, page = 1, limit = 20, search = null } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Number(limit) || 20);
  const offset = (safePage - 1) * safeLimit;

  const cacheKey = `${POOLS_OPEN_CACHE_KEY}:${type || 'all'}:${safePage}:${safeLimit}:${search || ''}`;
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    logger && logger.warn && logger.warn('cache.get error in listPools', e);
  }

  let sql = `
    SELECT p.id, p.title, p.type, p.min_entry, p.status, p.closing_date,
           COALESCE(p.total_pool_amount,0) AS total_pool_amount,
           COALESCE(p.total_stake,0) AS total_stake,
           COALESCE(w.participant_count, 0) AS participants
    FROM pools p
    LEFT JOIN pool_participants_summary w ON w.pool_id = p.id
    WHERE p.status IN ('open', 'locked')
  `;
  const params = [];

  if (type) {
    sql += ' AND p.type = ?';
    params.push(type);
  }

  if (search) {
    sql += ' AND (p.title LIKE ? OR p.description LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }

  sql += ' ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
  params.push(safeLimit, offset);

  const [rows] = await pool.query(sql, params);

  const mapped = rows.map((r) => {
    const total = Number(r.total_stake || r.total_pool_amount || 0);
    const target =
      r.type === 'pulse'
        ? Number(process.env.PULSE_TARGET || 500000)
        : r.type === 'grand'
        ? Number(process.env.GRAND_TARGET || 1000000)
        : 0;

    const progress = target > 0 ? Math.min(1, total / target) : 0;
    const countdown = r.closing_date
      ? Math.floor((new Date(r.closing_date).getTime() - Date.now()) / 1000)
      : null;

    return {
      id: r.id,
      title: r.title,
      type: r.type,
      min_entry: Number(r.min_entry || 0),
      status: r.status,
      participants: Number(r.participants || 0),
      total_stake: Number(total),
      target,
      progress,
      countdown
    };
  });

  try {
    await cache.set(cacheKey, JSON.stringify(mapped), POOLS_OPEN_TTL);
  } catch (e) {
    logger && logger.warn && logger.warn('cache.set error in listPools', e);
  }

  return mapped;
}



/**
 * getPoolDetails(poolId, userId)
 * Returns pool details + options + user entry.
 */

async function getPoolDetails(poolId, userId = null) {
  if (!poolId || isNaN(poolId)) throw new Error("invalid_pool_id");

  const cacheKey = `pool:${poolId}`;
  let basePool = null;

  // ---------------------------------------------------------
  // 1) TRY GET BASE POOL DATA FROM CACHE (NO USER DATA)
  // ---------------------------------------------------------
  try {
    const cached = await cache.get(cacheKey);
    if (cached) basePool = JSON.parse(cached);
  } catch (_) {}

  // ---------------------------------------------------------
  // 2) LOAD BASE POOL FROM DB IF NOT IN CACHE
  // ---------------------------------------------------------
  if (!basePool) {
    const [[poolRow]] = await pool.query(
      `
        SELECT id, title, description, type, min_entry, status, closing_date,
               total_pool_amount, total_stake, company_cut_percent
        FROM pools
        WHERE id = ?
        LIMIT 1
      `,
      [poolId]
    );

    if (!poolRow) throw new Error("pool_not_found");

    // --- TARGET (dynamic by pool type)
    let target = 0;
    if (poolRow.type === "pulse") {
      target = Number(process.env.TARGET_PULSE || 500000);
    } else if (poolRow.type === "grand") {
      target = Number(process.env.TARGET_GRAND || 1000000);
    }

    // --- OPTIONS
    const [options] = await pool.query(
      `
        SELECT id, title, total_stake, status
        FROM pool_options
        WHERE pool_id = ?
        ORDER BY id
      `,
      [poolId]
    );

    // --- PARTICIPANTS COUNT
    let participants = 0;
    try {
      const [[pCount]] = await pool.query(
        `SELECT COUNT(*) AS c FROM pool_entries WHERE pool_id = ?`,
        [poolId]
      );
      participants = Number(pCount?.c || 0);
    } catch (e) {
      logger && logger.warn && logger.warn("participants count failed", e);
    }

    const totalStake = Number(poolRow.total_stake || poolRow.total_pool_amount || 0);
    const cutPct = Number(
      poolRow.company_cut_percent ?? process.env.DEFAULT_COMPANY_CUT_PERCENT ?? 10
    );
    const companyCut = (cutPct / 100) * totalStake;
    const payoutPool = totalStake - companyCut;

    // --- BUILD BASE POOL OBJECT
    basePool = {
      id: poolRow.id,
      title: poolRow.title,
      description: poolRow.description,
      type: poolRow.type,
      status: poolRow.status,
      min_entry: Number(poolRow.min_entry || 0),
      closing_date: poolRow.closing_date,
      total_stake: totalStake,
      participants,
      company_cut_percent: cutPct,
      company_cut_amount: Number(companyCut),
      payout_pool: Number(payoutPool),
      options: options.map((o) => ({
        id: o.id,
        title: o.title,
        total_stake: Number(o.total_stake || 0),
        status: o.status,
      })),
      target,
      progress: target > 0 ? Math.min(1, totalStake / target) : 0,
    };

    // --- CACHE NON-USER VERSION
    try {
      await cache.set(cacheKey, JSON.stringify(basePool), 60);
    } catch (_) {}
  }

  // ---------------------------------------------------------
  // 3) LOAD USER ENTRY (ALWAYS LIVE, NEVER FROM CACHE)
  // ---------------------------------------------------------
  let user_data = {
    user_joined: false,
    user_option: null,
    user_stake: 0,
    entry_status: null,
    user_slip_id: null,
  };

  if (userId) {
    const [[entry]] = await pool.query(
      `
        SELECT option_id, amount, status, reference
        FROM pool_entries
        WHERE pool_id = ? AND user_id = ?
        LIMIT 1
      `,
      [poolId, userId]
    );

    if (entry) {
      user_data.user_joined = true;
      user_data.user_option = entry.option_id;
      user_data.user_stake = Number(entry.amount || 0);
      user_data.entry_status = entry.status;

      // -----------------------------------------------------
      // 4) SELECT CORRECT SLIP TYPE BASED ON POOL OUTCOME
      // -----------------------------------------------------
      let slipType = "pool_join"; // default for open pool

      if (entry.status === "won") slipType = "pool_win";
      else if (entry.status === "lost" || entry.status === "eliminated")
        slipType = "pool_loss";
      else if (entry.status === "refunded") slipType = "pool_refund";

      // -----------------------------------------------------
      // 5) FETCH LATEST SLIP FOR THIS USER + THIS POOL ENTRY
      // -----------------------------------------------------
      try {
        const [slipRows] = await pool.query(
          `
            SELECT slip_id
            FROM slips
            WHERE user_id = ?
              AND slip_type = ?
              AND JSON_EXTRACT(payload, '$.entry_reference') = ?
            ORDER BY id DESC
            LIMIT 1
          `,
          [userId, slipType, entry.reference]
        );

        if (slipRows.length) {
          user_data.user_slip_id = slipRows[0].slip_id;
        }
      } catch (err) {
        logger &&
          logger.warn &&
          logger.warn("getPoolDetails slip lookup failed", err);
      }
    }
  }

  // ---------------------------------------------------------
  // 6) RETURN FINAL MERGED RESULT
  // ---------------------------------------------------------
  return {
    ...basePool,
    ...user_data, // user fields override defaults
  };
}



/**
 * joinPool - atomic join
 */
async function joinPool({ userId, poolId, optionId, amount, reference = null }) {
  if (!reference) reference = `POOLENTRY-${Date.now()}-${uuidv4().slice(0,8)}`;

  await idempotency.ensureUnique(reference, 'pool_entries');

  // prevent double-join
  const [[exists]] = await pool.query(
    'SELECT id FROM pool_entries WHERE pool_id = ? AND user_id = ? LIMIT 1',
    [poolId, userId]
  );
  if (exists) {
    throw new Error('already_joined');
  }

  // validate pool & min
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

    // debit wallet (attempt conn signature first, fallback)
    let walletResult;
    try {
      walletResult = await walletService.debitUserWallet(conn, userId, amount, `Join pool ${poolId}`,{
    type: 'pool_join',
    gateway: 'internal',
    description: `Joined pool: ${pool.title}`,
  }
);
    } catch (wErr) {
      try {
        walletResult = await walletService.debitUserWallet(userId, amount, `Join pool ${poolId}`);
      } catch (inner) {
        throw new Error('wallet_debit_failed');
      }
    }

    const walletId = (walletResult && (walletResult.walletId || walletResult.wallet_id || walletResult.id)) || null;

    const [ins] = await conn.query(
      'INSERT INTO pool_entries (pool_id, option_id, user_id, wallet_id, amount, reference, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, "joined", NOW(), NOW())',
      [poolId, optionId, userId, walletId, amount, reference]
    );

    await conn.query(
      'UPDATE pool_options SET total_stake = COALESCE(total_stake,0) + ? WHERE id = ?',
      [amount, optionId]
    );
    await conn.query(
      'UPDATE pools SET total_pool_amount = COALESCE(total_pool_amount,0) + ?, total_stake = COALESCE(total_stake,0) + ? WHERE id = ?',
      [amount, amount, poolId]
    );

    await conn.query(
      'INSERT INTO pool_participants_summary (pool_id, participant_count, total_stake, updated_at) VALUES (?,1,?,NOW()) ON DUPLICATE KEY UPDATE participant_count = participant_count + 1, total_stake = total_stake + ?, updated_at = NOW()',
      [poolId, amount, amount]
    );

    await conn.commit();

    // invalidate caches
    try { await cache.del(`pool:${poolId}`); } catch (e) {}
    try { await cache.del(POOLS_OPEN_CACHE_KEY); } catch (e) {}
    try { await winmeter.invalidateWinmeter(poolId); } catch (e) {}
// create pool_join slip (best-effort)
// ----------------------------------------------
// CREATE POOL JOIN SLIP (safe, best-effort)
// ----------------------------------------------
try {
  // fetch required info
  const [[poolInfo]] = await pool.query(
    'SELECT title, type FROM pools WHERE id = ? LIMIT 1',
    [poolId]
  );
  const [[optInfo]] = await pool.query(
    'SELECT title FROM pool_options WHERE id = ? LIMIT 1',
    [optionId]
  );
  const [[userInfo]] = await pool.query(
    'SELECT username FROM users WHERE id = ? LIMIT 1',
    [userId]
  );

  // mask username
  const username = userInfo?.username || '';
  const masked =
    username.length <= 2
      ? '${username[0]}*'
      : '${username.slice(0, 3)}***';

  // build slip payload
  const payload = {
    pool_title: poolInfo?.title || 'Pool #${poolId}',
    option_title: optInfo?.title || null,
    stake: Number(amount),
    pool_type: poolInfo?.type || null,
    entry_reference: reference,
    user_masked: masked,
    entry_id: ins.insertId,
    created_at: new Date().toISOString()
  };

  // save slip
  await slipService.createSlip(userId, 'pool_join', payload);

} catch (err) {
  logger?.warn?.('joinPool slip creation failed', err);
}

    return {
      entryId: ins.insertId,
      reference,
      poolId,
      optionId,
      amount: Number(amount)
    };
  } catch (err) {
    await conn.rollback();
    logger && logger.error && logger.error('joinPool error', err);
    throw err;
  } finally {
    try { conn.release(); } catch (e) {}
  }

}

/**
 * listMyPools - lists pools the user has joined (open and settled)
 * returns array enriched with potential_win
 */
async function listMyPools(userId, { page = 1, limit = 50 } = {}) {
  if (!userId) throw new Error('invalid_user');

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Number(limit) || 50);
  const offset = (safePage - 1) * safeLimit;

  const sql = `
    SELECT p.id AS pool_id, p.title, p.type, p.status,
           pe.option_id, po.title AS option_title, pe.amount AS user_stake, pe.status AS entry_status,
           COALESCE(p.total_stake, p.total_pool_amount, 0) AS pool_total
    FROM pool_entries pe
    JOIN pools p ON p.id = pe.pool_id
    LEFT JOIN pool_options po ON po.id = pe.option_id
    WHERE pe.user_id = ?
    ORDER BY pe.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const [rows] = await pool.query(sql, [userId, safeLimit, offset]);

  const enriched = await Promise.all(rows.map(async (r) => {
    const poolId = Number(r.pool_id);
    const optionId = Number(r.option_id || 0);
    const stake = Number(r.user_stake || 0);
    let potential = 0;

    // compute option total safely
    if (optionId && poolId) {
      try {
        const [[optRow]] = await pool.query('SELECT COALESCE(total_stake,0) AS total FROM pool_options WHERE id = ? LIMIT 1', [optionId]);
        const optionTotal = Number(optRow?.total || 0);
        const poolTotal = Number(r.pool_total || 0);
        // use winmeter.getWinmeter which has defensive checks
        const winObj = await winmeter.getWinmeter(poolId, optionId, userId, stake);
        potential = Number(winObj.win || 0);
      } catch (e) {
        logger && logger.warn && logger.warn(`listMyPools winmeter error pool ${poolId} option ${optionId}`, e);
        potential = 0;
      }
    }

    return {
      pool_id: poolId,
      title: r.title,
      type: r.type,
      pool_status: r.status,
      user_option: optionId || null,
      user_option_title: r.option_title || null,
      user_stake: stake,
      entry_status: r.entry_status,
      potential_win: Number(potential || 0)
    };
  }));

  return enriched;
}

/**
 * recentActivity - lightweight feed (CACHED 20s)
 */
async function recentActivity({ limit = 20 } = {}) {
  const safeLimit = Math.min(100, Number(limit) || 20);
  const cacheKey = `recent:activity:${safeLimit}`;

  // Try cache
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {}

  // DB Query
  const [rows] = await pool.query(
    `SELECT pe.user_id, pe.pool_id, p.title AS pool_title, pe.amount, pe.created_at, u.username
     FROM pool_entries pe
     JOIN pools p ON p.id = pe.pool_id
     JOIN users u ON u.id = pe.user_id
     ORDER BY pe.created_at DESC
     LIMIT ?`, 
     [safeLimit]
  );

  const mapped = rows.map(r => ({
    user_id: r.user_id,
    user_masked: maskUsername(r.username),
    pool_id: r.pool_id,
    pool_title: r.pool_title,
    amount: Number(r.amount || 0),
    created_at: r.created_at
  }));

  // Save cache 20 seconds
  try { await cache.set(cacheKey, JSON.stringify(mapped), 20); } catch (e) {}

  return mapped;
}

async function getOptionTotal(optionId) {
  if (!optionId) return 0;

  const cacheKey = `option:total:${optionId}`;

  // Try cache first
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return Number(cached);
  } catch (e) {}

  // DB Query
  const [[r]] = await pool.query(
    'SELECT COALESCE(total_stake,0) AS total FROM pool_options WHERE id = ? LIMIT 1', 
    [optionId]
  );

  const total = Number(r ? r.total : 0);

  // Save cache 15 seconds
  try { await cache.set(cacheKey, String(total), 15); } catch (e) {}

  return total;
}

/**
 * getPoolLedger(poolId)
 * Returns full settlement ledger for a pool
 */
async function getPoolLedger(poolId) {
  if (!poolId || isNaN(poolId)) {
    throw new Error('invalid_pool_id');
  }

  const cacheKey = `pool:ledger:${poolId}`;

  // Try cache first
  try {
    const cached = await cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    logger && logger.warn && logger.warn('cache.get error in getPoolLedger', e);
  }

  // Fetch pool
  const [[poolRow]] = await pool.query(
    `SELECT 
       id, title, description, type, status, 
       total_stake, total_pool_amount, company_cut_percent, metadata
     FROM pools
     WHERE id = ?
     LIMIT 1`,
    [poolId]
  );

  if (!poolRow) {
    throw new Error('pool_not_found');
  }

  // Only show ledger if pool is closed/settled/rollover
  if (!['closed', 'settled', 'rollover'].includes(poolRow.status)) {
    throw new Error('pool_not_settled');
  }

  const totalStake = Number(poolRow.total_stake || poolRow.total_pool_amount || 0);
  const cutPct = Number(poolRow.company_cut_percent ?? process.env.DEFAULT_COMPANY_CUT_PERCENT ?? 10);
  const companyCutAmount = Number(((cutPct / 100) * totalStake).toFixed(2));
  const payoutPool = Number((totalStake - companyCutAmount).toFixed(2));

  // Try to read rollover_amount from metadata if present
  let rolloverAmount = 0;
  try {
    if (poolRow.metadata) {
      const meta = typeof poolRow.metadata === 'string'
        ? JSON.parse(poolRow.metadata)
        : poolRow.metadata;
      if (meta && meta.rollover_amount) {
        rolloverAmount = Number(meta.rollover_amount) || 0;
      }
    }
  } catch (e) {
    logger && logger.warn && logger.warn('getPoolLedger metadata parse failed', e);
  }

  // Fetch winners from pool_payouts
  const [winnerRows] = await pool.query(
    `SELECT pp.user_id, pp.amount AS amount_won, u.username
     FROM pool_payouts pp
     LEFT JOIN users u ON u.id = pp.user_id
     WHERE pp.pool_id = ? AND pp.status = 'completed'
     ORDER BY pp.amount DESC`,
    [poolId]
  );

  const winners = winnerRows.map((r) => ({
    user_id: r.user_id,
    masked_username: maskUsername(r.username),
    amount_won: Number(r.amount_won || 0)
  }));

  const result = {
    id: poolRow.id,
    title: poolRow.title,
    type: poolRow.type,
    status: poolRow.status,
    total_stake: totalStake,
    company_cut_percent: cutPct,
    company_cut_amount: companyCutAmount,
    payout_pool: payoutPool,
    winners,
    rollover_amount: rolloverAmount
  };

  // Cache for 60 seconds
  try {
    await cache.set(cacheKey, JSON.stringify(result), 60);
  } catch (e) {
    logger && logger.warn && logger.warn('cache.set error in getPoolLedger', e);
  }

  return result;
}


module.exports = {
  listPools,
  getPoolDetails,
  joinPool,
  listMyPools,
  recentActivity,
  getOptionTotal,
   getPoolLedger
};
