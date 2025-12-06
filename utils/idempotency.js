// utils/idempotency.js
const pool = require('../config/db');

// Try to insert webhook event; if duplicate (unique constraint), return false
async function tryInsertWebhook(provider, reference, eventType, payload, signature) {
  try {
    const sql = `INSERT INTO webhook_events (provider, reference, event_type, payload, signature, processed) VALUES (?, ?, ?, ?, ?, 0)`;
    await pool.query(sql, [provider, reference, eventType, JSON.stringify(payload || {}), signature || null]);
    return { inserted: true };
  } catch (err) {
    // duplicate key (already processed or inserted)
    if (err && err.code && (err.code === 'ER_DUP_ENTRY' || err.code === '23505')) {
      return { inserted: false };
    }
    throw err;
  }
}


async function ensureUnique(reference, table = 'pool_entries') {
  if (!reference) throw new Error('reference required for idempotency');
  const [rows] = await pool.query(`SELECT id FROM ${table} WHERE reference = ? LIMIT 1`, [reference]);
  if (rows.length) throw new Error('Duplicate reference');
  return true;
}

module.exports = { tryInsertWebhook, ensureUnique };

