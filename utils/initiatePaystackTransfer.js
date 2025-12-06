// utils/initiatePaystackTransfer.js
const axios = require('axios');
const paystackConfig = require('../config/paystack'); // your config; must export baseURL / headers or token

async function initiatePaystackTransfer({ amount, reference, destination }) {
  // Paystack transfer expects kobo if NGN — convert
  try {
    const kobo = Math.round(Number(amount) * 100);
    // destination can be: { bank_code, account_number, account_name } OR transfer recipient id stored previously
    // Use your paystack wrapper / config; below is generic
    const res = await paystackConfig.post('/transfer', {
      source: 'balance',
      amount: kobo,
      recipient: destination.recipient_id || undefined,
      reason: `Trebetta withdrawal ${reference}`,
      // if recipient id not provided, you might need to create transfer recipient first
      ...(!destination.recipient_id ? {
        recipient: undefined,
        // paystack create recipient flow should be used in production
      } : {})
    });
    // adapt to your config's return schema
    if (res.data && (res.data.status === true || res.status === 200)) {
      return { success: true, data: res.data };
    }
    return { success: false, error: res.data || 'unknown' };
  } catch (err) {
    console.error('initiatePaystackTransfer err', err?.response?.data || err.message);
    return { success: false, error: err?.response?.data || err.message };
  }
}

module.exports = { initiatePaystackTransfer };
