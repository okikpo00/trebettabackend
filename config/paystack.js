// config/paystack.js
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET;

if (!PAYSTACK_SECRET_KEY) {
  console.warn('⚠️ PAYSTACK_SECRET_KEY is not set. Paystack operations will fail until you add it to .env');
}

if (!PAYSTACK_WEBHOOK_SECRET) {
  console.warn('⚠️ PAYSTACK_WEBHOOK_SECRET is not set. Paystack webhooks cannot be verified correctly.');
}

module.exports = {
  PAYSTACK_SECRET_KEY,
  PAYSTACK_BASE_URL,
  PAYSTACK_WEBHOOK_SECRET
};
