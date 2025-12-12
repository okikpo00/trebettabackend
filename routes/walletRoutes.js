// routes/walletRoutes.js
const express = require('express');
const router = express.Router();

const depositController = require('../controllers/depositController');
const withdrawController = require('../controllers/withdrawController');
const walletController = require('../controllers/walletController');

// Your existing auth middleware
const auth = require('../middleware/auth');

// -------------------------------------
// WALLET ROUTES (AUTH REQUIRED)
// -------------------------------------
router.get('/balance', auth, walletController.getWallet);
router.get('/transactions', auth, walletController.getTransactions);

// Saved accounts
router.get('/accounts', auth, walletController.getSavedAccounts);
router.post('/accounts', auth, withdrawController.addSavedAccount);
router.delete('/accounts/:id', auth, withdrawController.deleteSavedAccount);

// Withdrawal fees (from system_settings.withdraw_fee_rules)
router.get('/fees', auth, walletController.getWithdrawalFees);

// Deposits (manual/semi-auto)
router.post('/deposit/initiate', auth, depositController.initiateDeposit);
router.get('/deposit/pending', auth, depositController.getPendingDeposit);


// PIN ROUTES
router.post('/pin/create', auth, withdrawController.createPin);
router.post('/pin/change', auth, withdrawController.changePin);
router.post('/pin/verify', auth, withdrawController.verifyPin);
router.post('/pin/reset/request', auth, withdrawController.requestPinReset);
router.post('/pin/reset/confirm', auth, withdrawController.resetPin);

// WITHDRAWAL FLOW
router.post('/withdraw/initiate', auth, withdrawController.initiateWithdraw);
router.post('/withdraw/confirm', auth, withdrawController.confirmWithdraw);

module.exports = router;
