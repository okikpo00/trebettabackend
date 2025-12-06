// middlewares/validateWithdrawal.js
const pool = require('../config/db');
const enforceWithdrawalLimits = require('../utils/enforceWithdrawalLimits');
const checkKycTier = require('../utils/checkKycTier');

/**
 * Middleware to validate withdrawal request before processing
 */
const validateWithdrawal = async (req, res, next) => {
  try {
    const userId = req.user?.id;
    const { amount } = req.body;

    if (!amount || isNaN(amount) || amount <= 0) {
      return res.status(400).json({ message: 'Invalid withdrawal amount.' });
    }

    // Check user wallet balance
    const [walletRows] = await pool.query('SELECT balance FROM wallets WHERE user_id = ?', [userId]);
    if (!walletRows.length) return res.status(404).json({ message: 'Wallet not found.' });

    const balance = walletRows[0].balance;
    if (amount > balance) {
      return res.status(400).json({ message: 'Insufficient balance.' });
    }

    // Get KYC tier & enforce limits
    const kycTier = await checkKycTier(userId);
    await enforceWithdrawalLimits(userId, amount, kycTier);

    // Proceed if all good
    req.kycTier = kycTier;
    req.walletBalance = balance;
    next();
  } catch (error) {
    console.error('Withdrawal validation error:', error.message);
    res.status(403).json({ message: error.message || 'Withdrawal validation failed.' });
  }
};

module.exports = validateWithdrawal;
