// utils/tokens.js
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function genAccessToken(payload) {
  const secret = process.env.USER_JWT_SECRET || process.env.JWT_SECRET;
  const expires = process.env.JWT_ACCESS_EXPIRES || '1h';
  return jwt.sign(payload, secret, { expiresIn: expires });
}

function genRefreshToken() {
  return crypto.randomBytes(40).toString('hex');
}

function hashToken(token) {
  // use sha256 for consistent DB storage
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { genAccessToken, genRefreshToken, hashToken };
