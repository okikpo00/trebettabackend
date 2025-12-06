// src/routes/poolRoutes.js
const express = require('express');
const router = express.Router();
const poolsCtrl = require('../controllers/poolsController');
const requireAuth = require('../middleware/auth'); // adapt path if different


router.get('/my', requireAuth, poolsCtrl.listMyPools);
router.get('/recent-activity', poolsCtrl.recentActivity);
router.get('/', poolsCtrl.listPools);
router.get('/:id', requireAuth, poolsCtrl.getPool);
router.get('/:id/ledger', requireAuth, poolsCtrl.getPoolLedger);
router.post('/:id/join', requireAuth, poolsCtrl.joinPool);
router.get('/:id/winmeter', requireAuth, poolsCtrl.getWinmeter);

module.exports = router;
