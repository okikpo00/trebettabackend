// src/routes/adminPoolRoutes.js
const express = require('express');
const router = express.Router();
const adminCtrl = require('../controllers/adminPoolController');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const adminRefund = require('../controllers/adminPoolRefundController');


router.post('/', requireAuth, requireAdmin, adminCtrl.createPool);
router.post('/:id/options', requireAuth, requireAdmin, adminCtrl.addOption);
router.post('/:id/lock', requireAuth, requireAdmin, adminCtrl.lockPool);
router.post('/:id/settle', requireAuth, requireAdmin, adminCtrl.settlePool);
router.post('/:id/refund', requireAuth, requireAdmin, adminRefund.refundPool);

router.get('/:id', requireAuth, requireAdmin, adminCtrl.getPoolById);
router.get('/', requireAuth, requireAdmin, adminCtrl.listPoolsByStatus);
router.get('/:id/participants', requireAuth, requireAdmin, adminCtrl.getPoolParticipants);
router.put('/:id/', requireAuth, requireAdmin, adminCtrl.updatePool);
router.get('/:id/ledger', requireAuth, requireAdmin, adminCtrl.getPoolLedger);


module.exports = router;

