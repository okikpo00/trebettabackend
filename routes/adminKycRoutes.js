// routes/adminKycRoutes.js
const express = require('express');
const router = express.Router();
const adminKyc = require('../controllers/adminKycController');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

router.get('/pending', requireAuth, requireAdmin, adminKyc.listPending);
router.post('/approve/:id', requireAuth, requireAdmin, adminKyc.approveKyc);
router.post('/reject/:id', requireAuth, requireAdmin, adminKyc.rejectKyc);

module.exports = router;
