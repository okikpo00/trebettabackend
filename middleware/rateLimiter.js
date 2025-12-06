// middlewares/rateLimiter.js
const rateLimit = require('express-rate-limit');

// Strict limiter for login and password reset
const authLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 8, // Only 8 attempts per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: false,
    message: "Too many attempts. Please wait a few minutes and try again."
  }
});

// More relaxed limiter for general admin APIs
const adminApiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: false,
    message: "Rate limit exceeded. Slow down."
  }
});

module.exports = {
  authLimiter,
  adminApiLimiter
};