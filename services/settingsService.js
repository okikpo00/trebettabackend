// services/settingsService.js
const pool = require('../config/db');
const cache = require('../utils/cache');
const logger = require('../utils/logger');

const SETTINGS_CACHE_KEY = 'system:settings';
const SETTINGS_CACHE_TTL = 60;

// Default values (if DB row is empty)
const DEFAULT_SETTINGS = {
  min_deposit: 100,
  min_withdraw: 1000,
  company_cut_percent: 10.0,
  rollover_enabled: 1,

  // NEW: default withdrawal fee rules
  withdraw_fee_rules: [
    { min: 0, max: 999, fee: 0 },
    { min: 1000, max: 4999, fee: 50 },
    { min: 5000, max: 49999, fee: 100 },
    { min: 50000, max: 999999999, fee: 200 }
  ]
};

/** ------------------------------------------------------------------
 * Ensure system_settings has exactly ONE row
 * ------------------------------------------------------------------ */
async function ensureSettingsRow() {
  console.log('settingsService.ensureSettingsRow › checking...');
  const [rows] = await pool.query('SELECT COUNT(*) AS cnt FROM system_settings');
  const count = rows[0]?.cnt || 0;

  if (count === 0) {
    console.log('settingsService.ensureSettingsRow › creating default row');

    await pool.query(
      `INSERT INTO system_settings
        (min_deposit, min_withdraw, company_cut_percent, rollover_enabled, withdraw_fee_rules)
       VALUES (?, ?, ?, ?, ?)`,
      [
        DEFAULT_SETTINGS.min_deposit,
        DEFAULT_SETTINGS.min_withdraw,
        DEFAULT_SETTINGS.company_cut_percent,
        DEFAULT_SETTINGS.rollover_enabled,
        JSON.stringify(DEFAULT_SETTINGS.withdraw_fee_rules)
      ]
    );
  }
}

/** ------------------------------------------------------------------
 * Read settings from DB
 * ------------------------------------------------------------------ */
async function getSettingsFromDb() {
  await ensureSettingsRow();

  const [rows] = await pool.query(
    'SELECT * FROM system_settings ORDER BY id ASC LIMIT 1'
  );

  const row = rows[0];

  return {
    id: row.id,
    min_deposit: Number(row.min_deposit || 0),
    min_withdraw: Number(row.min_withdraw || 0),
    company_cut_percent: Number(row.company_cut_percent || 0),
    rollover_enabled: row.rollover_enabled ? 1 : 0,

    // NEW: parse JSON safely
    withdraw_fee_rules: (() => {
      try {
        if (!row.withdraw_fee_rules) return DEFAULT_SETTINGS.withdraw_fee_rules;
        return JSON.parse(row.withdraw_fee_rules);
      } catch {
        return DEFAULT_SETTINGS.withdraw_fee_rules;
      }
    })(),

    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/** ------------------------------------------------------------------
 * Cached fetch
 * ------------------------------------------------------------------ */
async function getSettingsCached() {
  try {
    const cached = await cache.get(SETTINGS_CACHE_KEY);
    if (cached) {
      console.log('settingsService › from CACHE');
      return JSON.parse(cached);
    }
  } catch (err) {
    logger.warn('settingsService.getSettingsCached › cache.get error', err);
  }

  console.log('settingsService › from DB');
  const settings = await getSettingsFromDb();

  try {
    await cache.set(
      SETTINGS_CACHE_KEY,
      JSON.stringify(settings),
      SETTINGS_CACHE_TTL
    );
  } catch (e) {
    logger.warn('settingsService.getSettingsCached › cache.set error', e);
  }

  return settings;
}

/** ------------------------------------------------------------------
 * Update settings
 * ------------------------------------------------------------------ */
async function updateSettings(payload, adminId = null) {
  await ensureSettingsRow();

  const current = await getSettingsFromDb();

  // simple fields
  const minDeposit = Number(payload.min_deposit ?? current.min_deposit);
  const minWithdraw = Number(payload.min_withdraw ?? current.min_withdraw);
  const cutPercent = Number(payload.company_cut_percent ?? current.company_cut_percent);

  // boolean handling
  const rollRaw =
    payload.rollover_enabled !== undefined
      ? payload.rollover_enabled
      : current.rollover_enabled;
  const rolloverEnabled =
    rollRaw === true || rollRaw === 'true' || rollRaw === 1 ? 1 : 0;

  // NEW: Withdraw Fee Rules (JSON)
  let withdrawFeeRules = current.withdraw_fee_rules;

  if (payload.withdraw_fee_rules !== undefined) {
    try {
      const rules = Array.isArray(payload.withdraw_fee_rules)
        ? payload.withdraw_fee_rules
        : JSON.parse(payload.withdraw_fee_rules);

      // Validate rule structure
      for (const r of rules) {
        if (
          typeof r.min !== 'number' ||
          typeof r.max !== 'number' ||
          typeof r.fee !== 'number'
        ) {
          throw new Error('Invalid withdraw_fee_rules format');
        }
      }
      withdrawFeeRules = rules;
    } catch (err) {
      throw new Error('withdraw_fee_rules must be valid JSON array');
    }
  }

  // validations
  if (minDeposit < 0) throw new Error('Invalid min_deposit');
  if (minWithdraw < 0) throw new Error('Invalid min_withdraw');
  if (cutPercent < 0 || cutPercent > 100)
    throw new Error('Invalid company_cut_percent');

  const [[{ id }]] = await pool.query(
    'SELECT id FROM system_settings ORDER BY id ASC LIMIT 1'
  );

  await pool.query(
    `UPDATE system_settings
      SET min_deposit = ?, 
          min_withdraw = ?, 
          company_cut_percent = ?, 
          rollover_enabled = ?,
          withdraw_fee_rules = ?,
          updated_at = NOW()
      WHERE id = ?`,
    [
      minDeposit,
      minWithdraw,
      cutPercent,
      rolloverEnabled,
      JSON.stringify(withdrawFeeRules),
      id
    ]
  );

  const updated = await getSettingsFromDb();

  // update cache
  try {
    await cache.set(
      SETTINGS_CACHE_KEY,
      JSON.stringify(updated),
      SETTINGS_CACHE_TTL
    );
  } catch (e) {
    logger.warn('settingsService.updateSettings › cache.set error', e);
  }

  return { before: current, after: updated };
}

/** ------------------------------------------------------------------
 * Get a single setting
 * ------------------------------------------------------------------ */
async function getSystemSetting(key) {
  const settings = await getSettingsCached();
  return settings[key];
}

/** ------------------------------------------------------------------
 * NEW: Dynamic fee calculator
 * ------------------------------------------------------------------ */
async function getDynamicWithdrawalFee(amount) {
  const rules = await getSystemSetting('withdraw_fee_rules');
  const amt = Number(amount);

  for (const r of rules) {
    if (amt >= r.min && amt <= r.max) {
      return Number(r.fee);
    }
  }

  // fallback
  return 0;
}

module.exports = {
  getSettingsCached,
  updateSettings,
  getSystemSetting,
  getDynamicWithdrawalFee,
  ensureSettingsRow
};
