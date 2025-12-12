// routes/adminWithdrawRoutes.js
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const adminWithdraw = require('../controllers/adminWithdrawalController');

// GET /admin/withdrawals
router.get('/', requireAuth, requireAdmin, adminWithdraw.listAllWithdrawals);

// POST /admin/withdrawals/:id/approve
router.post('/:id/approve', requireAuth, requireAdmin, adminWithdraw.approveWithdrawal);

// POST /admin/withdrawals/:id/reject
router.post('/:id/reject', requireAuth, requireAdmin, adminWithdraw.rejectWithdrawal);

module.exports = router;
