// utils/initiateMonnifyTransfer.js
const monnifyConfig = require('../config/monnify'); // should export axios instance or helper
async function initiateMonnifyTransfer({ amount, reference, destination }) {
  try {
    // Monnify typically expects amount in Naira (no minor units)
    const res = await monnifyConfig.post('/transactions/disburse', {
      amount: Number(amount),
      currency: 'NGN',
      reference,
      bankCode: destination?.bank_code,
      accountNumber: destination?.account_number,
      accountName: destination?.account_name,
      narration: `Trebetta withdrawal ${reference}`
    });
    if (res.data && (res.status === 200 || res.status === 201)) {
      return { success: true, data: res.data };
    }
    return { success: false, error: res.data || 'unknown' };
  } catch (err) {
    console.error('initiateMonnifyTransfer err', err?.response?.data || err.message);
    return { success: false, error: err?.response?.data || err.message };
  }
}

module.exports = { initiateMonnifyTransfer };
