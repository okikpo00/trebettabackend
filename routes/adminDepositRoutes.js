const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const depositAdmin = require('../controllers/depositAdminController');

router.get('/', requireAuth, requireAdmin, depositAdmin.listDeposits);
router.post('/manual', requireAuth, requireAdmin, depositAdmin.manualDeposit);

module.exports = router;
