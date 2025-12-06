// services/dva.js
const axios = require('axios');
const pool = require('../config/db');
const { auditLog } = require('../utils/auditLog');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
const FLW_SECRET = process.env.FLW_SECRET_KEY;

// Create both Paystack + Flutterwave DVA and store whichever succeeds
async function createDVA(userId) {
  const [userRows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!userRows.length) throw new Error('User not found');
  const user = userRows[0];

  const [walletRows] = await pool.query('SELECT * FROM wallets WHERE user_id = ? LIMIT 1', [userId]);
  if (!walletRows.length) throw new Error('Wallet not found');
  const wallet = walletRows[0];

  let paystackData = null;
  let flutterwaveData = null;

  try {
    const paystackRes = await axios.post(
      'https://api.paystack.co/dedicated_account',
      {
        customer: {
          email: user.email,
          first_name: user.full_name?.split(' ')[0] || '',
          last_name: user.full_name?.split(' ')[1] || '',
          phone: user.phone || '',
        },
        preferred_bank: 'titan-paystack',
        country: 'NG',
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );
    paystackData = paystackRes.data.data;
    await pool.query(
      'INSERT INTO virtual_accounts (user_id, wallet_id, provider, bank_name, account_number, account_name, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
      [userId, wallet.id, 'paystack', paystackData.bank.name, paystackData.account_number, paystackData.account_name, JSON.stringify(paystackData)]
    );
    await auditLog(null, userId, 'CREATE_DVA', 'wallet', wallet.id, { provider: 'paystack' });
  } catch (err) {
    console.warn('Paystack DVA failed:', err.response?.data || err.message);
  }

  try {
    const flwRes = await axios.post(
      'https://api.flutterwave.com/v3/virtual-account-numbers',
      {
        email: user.email,
        bvn: user.bvn || '12345678901',
        phonenumber: user.phone || '',
        firstname: user.full_name?.split(' ')[0] || '',
        lastname: user.full_name?.split(' ')[1] || '',
        narration: `Trebetta Wallet - ${user.full_name}`,
        tx_ref: `DVA-FLW-${Date.now()}`,
        is_permanent: true,
      },
      { headers: { Authorization: `Bearer ${FLW_SECRET}` } }
    );
    flutterwaveData = flwRes.data.data;
    await pool.query(
      'INSERT INTO virtual_accounts (user_id, wallet_id, provider, bank_name, account_number, account_name, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())',
      [userId, wallet.id, 'flutterwave', flutterwaveData.bank_name, flutterwaveData.account_number, flutterwaveData.account_name, JSON.stringify(flutterwaveData)]
    );
    await auditLog(null, userId, 'CREATE_DVA', 'wallet', wallet.id, { provider: 'flutterwave' });
  } catch (err) {
    console.warn('Flutterwave DVA failed:', err.response?.data || err.message);
  }

  if (!paystackData && !flutterwaveData) throw new Error('All DVA creation attempts failed');
  return { paystack: paystackData, flutterwave: flutterwaveData };
}

module.exports = { createDVA };
