// src/services/flutterwaveBankService.js
const axios = require('axios');

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_BASE_URL = process.env.FLW_BASE_URL || 'https://api.flutterwave.com/v3';
const FLW_REDIRECT_URL =
  process.env.FLW_REDIRECT_URL || 'https://trebetta.com/payment-complete'; // ✅ FIXED

if (!FLW_SECRET_KEY) {
  console.warn('⚠️ FLW_SECRET_KEY is not set. Flutterwave bank transfer will fail until you add it to .env');
}

/**
 * Create a Flutterwave "Pay with bank transfer" payment
 * Returns bank account details for the user to transfer into
 */
async function createFlutterwaveTransfer(user, amount, reference) {
  console.log(
    'flutterwaveBankService.createFlutterwaveTransfer › user:',
    user.id,
    'amount:',
    amount,
    'ref:',
    reference
  );

  try {
    const res = await axios.post(
      `${FLW_BASE_URL}/payments`,
      {
        tx_ref: reference,
        amount,
        currency: 'NGN',
        payment_options: 'banktransfer',

        // ✅ FIXED: correct redirect URL (required by Flutterwave)
        redirect_url: FLW_REDIRECT_URL,

        customer: {
          email: user.email,
          name: user.full_name || user.username || `User ${user.id}`
        },

        narration: `Trebetta wallet deposit - ${reference}`,

        meta: {
          user_id: user.id
        }
      },
      {
        headers: {
          Authorization: `Bearer ${FLW_SECRET_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = res.data;
    console.log('Flutterwave create payment raw response:', JSON.stringify(data, null, 2));

    if (!data || data.status !== 'success' || !data.data) {
      throw new Error('Flutterwave did not return a successful response');
    }

    const paymentData = data.data;

    // ✅ FIXED: support both old and new Flutterwave responses
    const metaAuth =
      paymentData?.meta?.authorization ||
      paymentData?.authorization ||
      null;

    const bank_name = metaAuth?.receiver_bank || metaAuth?.bank || null;
    const account_number =
      metaAuth?.transfer_account || metaAuth?.account_number || null;
    const account_name =
      metaAuth?.transfer_reference || metaAuth?.account_name || null;
    const expires_at = metaAuth?.transfer_expiration || metaAuth?.expiry || null;

    // ⚠️ FIXED: Better warning message
    if (!account_number || !bank_name) {
      console.warn(
        '⚠️ No bank details returned. Flutterwave may be returning hosted link only. ' +
          'Enable "Bank Transfer" in FW payment methods or complete business verification.'
      );
    }

    return {
      bank_name,
      account_number,
      account_name,
      expires_at,

      // ✅ FIXED: include hosted_link for UI fallback
      hosted_link: paymentData.link || null,

      provider_reference: paymentData.tx_ref,
      provider_response: paymentData
    };
  } catch (err) {
    console.error(
      '❌ flutterwaveBankService.createFlutterwaveTransfer error:',
      err.response?.data || err.message || err
    );
    throw err;
  }
}

/**
 * Resolve bank account (used for withdrawal verification)
 */
async function resolveBankAccount(bank_code, account_number) {
  console.log(
    'flutterwaveBankService.resolveBankAccount › bank_code:',
    bank_code,
    'account_number:',
    account_number
  );

  try {
    // Fix base URL (remove trailing slash)
    const base = FLW_BASE_URL.replace(/\/+$/, '');

    // Correct parameter: Flutterwave uses account_bank (NOT bank_code)
    const url = `${base}/accounts/resolve?account_number=${account_number}&account_bank=${bank_code}`;

    console.log("Resolve URL:", url);

    const res = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${FLW_SECRET_KEY}`
      }
    });

    const data = res.data;
    console.log('Flutterwave resolve account raw response:', JSON.stringify(data, null, 2));

    if (!data || data.status !== 'success' || !data.data) {
      throw new Error('Failed to resolve bank account');
    }

    return {
      account_name: data.data.account_name,
      account_number: data.data.account_number,
      bank_code,
      bank_name: data.data.bank_name || null,
      raw: data.data
    };
  } catch (err) {
    console.error(
      '❌ flutterwaveBankService.resolveBankAccount error:',
      err.response?.data || err.message || err
    );
    throw err;
  }
}


module.exports = {
  createFlutterwaveTransfer,
  resolveBankAccount
};

