// src/services/winmeterService.js
const pool = require('../config/db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const COMPANY_CUT_PCT = Number(process.env.DEFAULT_COMPANY_CUT_PERCENT || 10);
const WINMETER_TTL = 15; // seconds

function calcWinMeter(userStake, optionTotal, poolTotal) {
  if (!optionTotal || optionTotal <= 0) return 0;
  const payoutPool = Number(poolTotal) * (1 - COMPANY_CUT_PCT / 100);
  return (userStake / optionTotal) * payoutPool;
}

/**
 * getWinmeter(poolId, optionId, userId, userStake = null)
 * Returns { stake, optionTotal, poolTotal, win, status }
 */
async function getWinmeter(poolId, optionId, userId = null, userStake = null) {
  // input validation (defensive)
  if (!poolId || isNaN(poolId)) throw new Error('Invalid pool id');
  if (!optionId || isNaN(optionId)) throw new Error('Invalid option id');

  const key = `winmeter:pool:${poolId}:option:${optionId}:user:${userId || 'anon'}`;

  try {
    const cached = await cache.get(key);
    if (cached) {
      // cached may be stringified object
      return typeof cached === 'string' ? JSON.parse(cached) : cached;
    }
  } catch (e) {
    logger && logger.warn && logger.warn('winmeter cache.get error', e);
  }

  // fetch pool totals and option totals
  const [[poolRow]] = await pool.query(
    'SELECT COALESCE(total_stake, 0) AS total_pool FROM pools WHERE id = ? LIMIT 1',
    [poolId]
  );
  const [[optRow]] = await pool.query(
    'SELECT COALESCE(total_stake, 0) AS option_total, status FROM pool_options WHERE id = ? LIMIT 1',
    [optionId]
  );

  const poolTotal = Number(poolRow?.total_pool || 0);
  const optionTotal = Number(optRow?.option_total || 0);

  // if userStake not provided fetch from entries (safe)
  let stake = Number(userStake || 0);
  if ((userStake === null || userStake === undefined) && userId) {
    try {
      const [uRows] = await pool.query(
        'SELECT COALESCE(SUM(amount),0) AS s FROM pool_entries WHERE pool_id = ? AND option_id = ? AND user_id = ?',
        [poolId, optionId, userId]
      );
      stake = Number(uRows?.[0]?.s || 0);
    } catch (e) {
      stake = Number(userStake || 0);
    }
  }

  // eliminated option -> zero win
  const optStatus = optRow?.status || 'active';
  if (optStatus === 'eliminated') {
    const res = { stake, optionTotal, poolTotal, win: 0, status: 'eliminated' };
    try { await cache.set(key, JSON.stringify(res), WINMETER_TTL); } catch (e) { /* ignore cache errors */ }
    return res;
  }

  const win = calcWinMeter(stake, optionTotal, poolTotal);
  const result = { stake, optionTotal, poolTotal, win: Number(win || 0), status: optStatus };

  try { await cache.set(key, JSON.stringify(result), WINMETER_TTL); } catch (e) { /* ignore cache errors */ }

  return result;
}

async function invalidateWinmeter(poolId) {
  if (!poolId) return;
  try {
    // Keep simple: delete the broad key space (your cache util might accept a pattern or delete many keys)
    await cache.del(`winmeter:pool:${poolId}`);
  } catch (e) {
    logger && logger.warn && logger.warn('invalidateWinmeter cache.del failed', e);
  }
}

module.exports = { getWinmeter, calcWinMeter, invalidateWinmeter };
