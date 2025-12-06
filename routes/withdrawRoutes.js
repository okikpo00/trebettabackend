// routes/withdrawRoutes.js
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const withdrawController = require('../controllers/withdrawUserController');

router.post('/request', requireAuth, withdrawController.requestWithdrawal);
router.get('/', requireAuth, withdrawController.listUserWithdrawals);

module.exports = router;
