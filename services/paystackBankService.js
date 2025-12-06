// services/paystackBankService.js
const axios = require('axios');
const { PAYSTACK_SECRET_KEY, PAYSTACK_BASE_URL } = require('../config/paystack');

if (!PAYSTACK_SECRET_KEY) {
  console.warn('⚠️ PAYSTACK_SECRET_KEY is not set. Paystack bank transfer will fail until you add it to .env');
}

/**
 * Create a Paystack "Pay with bank transfer" payment
 * Returns bank account details for the user to transfer into
 */
async function createPaystackTransfer(user, amount, reference) {
  console.log('paystackBankService.createPaystackTransfer › user:', user.id, 'amount:', amount, 'ref:', reference);

  try {
    const res = await axios.post(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        reference,
        amount: Math.round(amount * 100), // kobo
        currency: 'NGN',
        email: user.email,
        channels: ['bank_transfer'],
        metadata: {
          user_id: user.id,
          narration: `Trebetta wallet deposit - ${reference}`
        }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = res.data;
    console.log('Paystack create payment raw response:', JSON.stringify(data, null, 2));

    if (!data || !data.status || !data.data) {
      throw new Error('Paystack did not return a successful response');
    }

    const paymentData = data.data;
    const auth = paymentData.authorization || paymentData.meta?.authorization || null;

    const bank_name = auth?.receiver_bank || auth?.bank || null;
    const account_number = auth?.transfer_account || auth?.account_number || null;
    const account_name = auth?.account_name || null;
    const expires_at = auth?.transfer_expiration || null;

    if (!account_number || !bank_name) {
      console.warn('⚠️ Paystack authorization missing bank details. Check integration.');
    }

    return {
      bank_name,
      account_number,
      account_name,
      expires_at,
      provider_reference: paymentData.reference,
      provider_response: paymentData
    };
  } catch (err) {
    console.error(
      '❌ paystackBankService.createPaystackTransfer error:',
      err.response?.data || err.message || err
    );
    throw err;
  }
}

module.exports = {
  createPaystackTransfer
};
