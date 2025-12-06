// routes/adminWithdrawRoutes.js
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const adminWithdraw = require('../controllers/adminWithdrawalController');

router.get('/', requireAuth, requireAdmin, adminWithdraw.listAllWithdrawals);
router.post('/:id/approve', requireAuth, requireAdmin, adminWithdraw.approveWithdrawal);
router.post('/:id/reject', requireAuth, requireAdmin, adminWithdraw.rejectWithdrawal);

module.exports = router;
