// src/routes/adminWinnerRoutes.js
const express = require('express');
const router = express.Router();
const tickerCtrl = require('../controllers/winnerTickerController');
const requireAuth = require('../middleware/auth');      // adjust import path if different
const requireAdmin = require('../middleware/requireAdmin'); // adjust if you use a different file

// admin: add manual winner
router.post('/', requireAuth, requireAdmin, tickerCtrl.adminAdd);

// admin: list paginated winners
router.get('/', requireAuth, requireAdmin, tickerCtrl.adminList);

// admin: delete
router.delete('/:id', requireAuth, requireAdmin, tickerCtrl.adminDelete);

module.exports = router;