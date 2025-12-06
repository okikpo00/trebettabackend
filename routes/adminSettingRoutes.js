// routes/adminSettingsRoutes.js
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const adminSettings = require('../controllers/adminSettingsController');

// GET /api/admin/settings
router.get('/', requireAuth, requireAdmin, adminSettings.getSettings);

// PUT /api/admin/settings
router.put('/', requireAuth, requireAdmin, adminSettings.updateSettings);

module.exports = router;
