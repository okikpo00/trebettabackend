// services/slipService.js
const pool = require('../config/db');
const generateReference = require('../utils/generateReference');
const logger = require('../utils/logger');

// local helper to mask username (same style as userPoolService)
function maskUsername(u) {
  if (!u) return 'user';
  if (u.length <= 2) return `${u[0]}*`;
  return `${u.slice(0, 3)}***`;
}

const VALID_TYPES = new Set([
  'pool_join',
  'pool_win',
  'pool_loss',
  'pool_refund',
  'deposit',
  'withdrawal'
]);

/**
 * createSlip
 * userId: BIGINT
 * slipType: one of VALID_TYPES
 * payload: plain JS object (will be JSON.stringified)
 *
 * Returns: slip_id (string)
 */
async function createSlip(userId, slipType, payload) {
  try {
    if (!userId || isNaN(userId)) {
      throw new Error('invalid_user_id');
    }

    if (!VALID_TYPES.has(slipType)) {
      throw new Error(`invalid_slip_type_${slipType}`);
    }

    const slipId = generateReference('SLP'); // e.g. SLP_1763..._83c51b67

    const jsonPayload = JSON.stringify(payload || {});

    await pool.query(
      `INSERT INTO slips (slip_id, user_id, slip_type, payload)
       VALUES (?, ?, ?, ?)`,
      [slipId, userId, slipType, jsonPayload]
    );

    return slipId;
  } catch (err) {
    logger && logger.error && logger.error('createSlip error', err);
    // best-effort: do not throw in production critical paths if you call it inside other flows
    throw err;
  }
}

/**
 * createSlipWithMaskedUser
 * Convenience helper if you want masked username in payload.
 */
async function createSlipWithMaskedUser(userId, slipType, payloadBase = {}) {
  try {
    const [[userRow]] = await pool.query(
      'SELECT username FROM users WHERE id = ? LIMIT 1',
      [userId]
    );

    const masked = maskUsername(userRow?.username || 'user');

    const payload = {
      user_masked: masked,
      ...payloadBase
    };

    return await createSlip(userId, slipType, payload);
  } catch (err) {
    logger && logger.error && logger.error('createSlipWithMaskedUser error', err);
    throw err;
  }
}

/**
 * getSlipById
 * Returns full slip row (parsed payload)
 */
async function getSlipById(slipId) {
  const [rows] = await pool.query(
    `SELECT slip_id, user_id, slip_type, payload, created_at
     FROM slips
     WHERE slip_id = ?
     LIMIT 1`,
    [slipId]
  );

  if (!rows.length) return null;

  const row = rows[0];
  let payload = null;
  try {
    payload = typeof row.payload === 'string'
      ? JSON.parse(row.payload)
      : row.payload;
  } catch (e) {
    payload = {};
  }

  return {
    slip_id: row.slip_id,
    user_id: row.user_id,
    slip_type: row.slip_type,
    payload,
    created_at: row.created_at
  };
}

/**
 * getSlipForUser
 * Ensures slip belongs to the given user.
 */
async function getSlipForUser(slipId, userId) {
  const [rows] = await pool.query(
    `SELECT slip_id, user_id, slip_type, payload, created_at
     FROM slips
     WHERE slip_id = ? AND user_id = ?
     LIMIT 1`,
    [slipId, userId]
  );

  if (!rows.length) return null;

  const row = rows[0];
  let payload = null;
  try {
    payload = typeof row.payload === 'string'
      ? JSON.parse(row.payload)
      : row.payload;
  } catch (e) {
    payload = {};
  }

  return {
    slip_id: row.slip_id,
    user_id: row.user_id,
    slip_type: row.slip_type,
    payload,
    created_at: row.created_at
  };
}

module.exports = {
  createSlip,
  createSlipWithMaskedUser,
  getSlipById,
  getSlipForUser
};
