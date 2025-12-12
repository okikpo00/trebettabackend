// routes/depositRoutes.js
const express = require('express');
const router = express.Router();
const depositCtrl = require('../controllers/depositController'); // <-- use new manual controller
const requireAuth = require('../middleware/auth');

// USER-FACING MANUAL DEPOSIT
router.post('/deposit/initiate', requireAuth, depositCtrl.initiateDeposit);

// (Optional) You can now remove or ignore old webhook routes
// since Flutterwave / Paystack are no longer used for deposits.

module.exports = router;

