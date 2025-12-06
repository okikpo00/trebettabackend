// routes/depositRoutes.js
const express = require('express');
const router = express.Router();
const depositCtrl = require('../controllers/depositUserController');
const webhookCtrl = require('../controllers/webhookController');
const requireAuth = require('../middleware/auth'); // your middleware

// user-facing
router.post('/deposit/initiate', requireAuth, depositCtrl.initiateDeposit);

// webhooks (no auth)
router.post('/webhook/paystack', webhookCtrl.paystackHandler);
router.post('/webhook/flutterwave', webhookCtrl.flutterwaveHandler);

module.exports = router;
