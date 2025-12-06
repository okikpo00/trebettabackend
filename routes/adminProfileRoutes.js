// routes/adminProfileRoutes.js
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const adminProfile = require('../controllers/adminProfileController');

// GET /api/admin/me
router.get('/me', requireAuth, requireAdmin, adminProfile.getMe);

// PUT /api/admin/me/update
router.put('/me/update', requireAuth, requireAdmin, adminProfile.updateMe);

// POST /api/admin/me/change-password
router.post('/me/change-password', requireAuth, requireAdmin, adminProfile.changePassword);

module.exports = router;
