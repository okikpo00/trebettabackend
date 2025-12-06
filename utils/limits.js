// utils/limits.js
const { getSystemSetting } = require('../services/settingsService');

// ENV fallbacks (still used for minimum deposit + auto-withdraw)
const AUTO_WITHDRAWAL_THRESHOLD = Number(process.env.WITHDRAW_AUTO_THRESHOLD || 10000);
const MIN_DEPOSIT = Number(process.env.MIN_DEPOSIT || 500);
const MIN_WITHDRAWAL = Number(process.env.MIN_WITHDRAWAL || 1000);

/**
 * Normalize KYC tier safely.
 */
function normalizeTier(tier) {
  if (tier === null || tier === undefined) return 'tier1';

  if (typeof tier === 'number') {
    return `tier${tier}`;
  }

  const t = String(tier).trim().toLowerCase();

  if (['1', 'tier1', 'basic', 'unverified'].includes(t)) return 'tier1';
  if (['2', 'tier2', 'verified'].includes(t)) return 'tier2';
  if (['3', 'tier3', 'premium'].includes(t)) return 'tier3';

  return 'tier1';
}

/**
 * Daily/monthly withdrawal limits per KYC tier.
 */
function getLimitsForTier(tier) {
  const normalized = normalizeTier(tier);

  switch (normalized) {
    case 'tier2':
      return { daily: 100000, monthly: 500000 };
    case 'tier3':
      return { daily: 300000, monthly: 2000000 };
    default:
      return { daily: 10000, monthly: 50000 }; // tier1
  }
}

/**
 * ⚡ NEW: Get withdrawal fee dynamically from system settings.
 *
 * Reads system_settings.withdraw_fee_rules (JSON array)
 * Example:
 * [
 *   { "min": 1000, "max": 3000, "fee": 20 },
 *   { "min": 4000, "max": 9000, "fee": 30 },
 *   { "min": 100000, "max": null, "fee": 100 }
 * ]
 *
 * If no rules exist, fallback to old static fee system.
 */
async function getWithdrawalFee(amount) {
  const amt = Number(amount || 0);
  if (!amt || amt <= 0) return 0;

  try {
    const rules = await getSystemSetting('withdraw_fee_rules');

    if (rules && Array.isArray(rules) && rules.length > 0) {
      for (const r of rules) {
        const min = Number(r.min || 0);
        const max = r.max === null ? null : Number(r.max);

        if (max === null) {
          // rule with no upper limit
          if (amt >= min) return Number(r.fee || 0);
        } else {
          if (amt >= min && amt <= max) return Number(r.fee || 0);
        }
      }
    }
  } catch (err) {
    console.warn('getWithdrawalFee › failed to read settings, using fallback', err);
  }

  // Fallback static logic (only used if DB rules missing)
  if (amt >= 50000) return 200;
  if (amt >= 5000) return 100;
  if (amt >= 1000) return 50;
  return 0;
}

module.exports = {
  AUTO_WITHDRAWAL_THRESHOLD,
  MIN_DEPOSIT,
  MIN_WITHDRAWAL,
  getLimitsForTier,
  getWithdrawalFee
};
