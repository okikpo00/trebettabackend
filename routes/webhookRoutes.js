// routes/webhookRoutes.js
const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

// MUST USE RAW BODY FOR SIGNATURE VERIFICATION
router.post('/flutterwave', express.raw({ type: '*/*' }), webhookController.flutterwaveHandler);
router.post('/paystack', express.raw({ type: '*/*' }), webhookController.paystackHandler);

module.exports = router;
