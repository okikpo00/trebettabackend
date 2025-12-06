// routes/adminWalletRoutes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminWalletController');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

router.get('/', requireAuth, requireAdmin, controller.listWallets);
router.get('/:id', requireAuth, requireAdmin, controller.getWallet);
router.post('/credit/:id', requireAuth, requireAdmin, controller.creditWallet);
router.post('/debit/:id', requireAuth, requireAdmin, controller.debitWallet);
router.patch('/freeze/:id', requireAuth, requireAdmin, controller.setWalletStatus);
router.patch('/unfreeze/:id', requireAuth, requireAdmin, controller.setWalletStatus);

module.exports = router;
