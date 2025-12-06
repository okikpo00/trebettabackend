const express = require('express');
const router = express.Router();
const rolloverController = require('../controllers/rolloverController');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

// Get rollover balance
router.get('/', requireAuth, requireAdmin, rolloverController.getRolloverBalance);

// Apply rollover to a pool
router.post('/apply', requireAuth, requireAdmin, rolloverController.applyRolloverToPool);

// Get rollover application history
router.get('/history', requireAuth, requireAdmin, rolloverController.getRolloverHistory);

module.exports = router;
