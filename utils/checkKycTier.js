// utils/checkKycTier.js
const pool = require('../config/db');

/**
 * Determines user's KYC tier and withdrawal limits
 * @param {Number} userId
 * @returns {Object} { tier, dailyLimit, monthlyLimit }
 */
const checkKycTier = async (userId) => {
  const [rows] = await pool.query(
    'SELECT status, document_type, selfie_url, proof_of_address FROM kyc_verificationss WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  );

  if (!rows.length) {
    return { tier: 1, dailyLimit: 10000, monthlyLimit: 50000 };
  }

  const record = rows[0];
  if (record.status !== 'approved') {
    return { tier: 1, dailyLimit: 10000, monthlyLimit: 50000 };
  }

  // Tier 3: Has proof of address and ID verified
  if (record.proof_of_address && record.selfie_url) {
    return { tier: 3, dailyLimit: 300000, monthlyLimit: 2000000 };
  }

  // Tier 2: Has valid ID + selfie
  if (record.document_type && record.selfie_url) {
    return { tier: 2, dailyLimit: 100000, monthlyLimit: 500000 };
  }

  // Default fallback
  return { tier: 1, dailyLimit: 10000, monthlyLimit: 50000 };
};

module.exports = checkKycTier;
