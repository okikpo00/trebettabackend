const express = require('express');
const router = express.Router();
const adminDashboard = require('../controllers/adminDashboardController');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

router.get('/overview', requireAuth, requireAdmin, adminDashboard.overview);
router.get('/wallets', requireAuth, requireAdmin, adminDashboard.wallets);
router.get('/pools', requireAuth, requireAdmin, adminDashboard.pools);
router.get('/activity', requireAuth, requireAdmin, adminDashboard.activity);

module.exports = router;
