const express = require('express');
const router = express.Router();
const { flutterwaveWebhook } = require('../controllers/flutterwaveWebhookController');

// IMPORTANT: raw body
router.post(
  '/flutterwave',
  express.raw({ type: 'application/json' }),
  flutterwaveWebhook
);

module.exports = router;
