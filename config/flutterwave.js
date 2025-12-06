// config/flutterwave.js
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const FLW_PUBLIC_KEY = process.env.FLW_PUBLIC_KEY;
const FLW_BASE_URL = process.env.FLW_BASE_URL || 'https://api.flutterwave.com/v3';
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH;

if (!FLW_SECRET_KEY) {
  console.warn('⚠️ FLW_SECRET_KEY is not set. Flutterwave operations will fail until you add it to .env');
}

if (!FLW_SECRET_HASH) {
  console.warn('⚠️ FLW_SECRET_HASH is not set. Flutterwave webhooks cannot be verified correctly.');
}

module.exports = {
  FLW_SECRET_KEY,
  FLW_PUBLIC_KEY,
  FLW_BASE_URL,
  FLW_SECRET_HASH
};
