const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const ctrl = require('../controllers/depositMatchAdminController');

// list pending
router.get('/pending', requireAuth, requireAdmin, ctrl.listPending);
router.get('/expired', requireAuth, requireAdmin, ctrl.listExpired);
// match deposit
router.post('/match', requireAuth, requireAdmin, ctrl.matchDeposit);

// expire old
router.post('/expire', requireAuth, requireAdmin, ctrl.expireOld);

module.exports = router;
