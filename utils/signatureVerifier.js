// utils/signatureVerifier.js
const crypto = require('crypto');

function verifyPaystackSignature(rawBodyBuffer, signatureHeader, secret) {
  if (!rawBodyBuffer) return false;
  const hmac = crypto.createHmac('sha512', secret);
  hmac.update(rawBodyBuffer);
  const computed = hmac.digest('hex');
  try {
    const a = Buffer.from(computed);
    const b = Buffer.from(signatureHeader);
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

module.exports = { verifyPaystackSignature };
