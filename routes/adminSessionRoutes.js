// routes/adminSessionRoutes.js
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const adminSessions = require('../controllers/adminSessionController');

// GET /api/admin/sessions
router.get('/', requireAuth, requireAdmin, adminSessions.listSessions);

// POST /api/admin/sessions/:id/kill
router.post('/:id/kill', requireAuth, requireAdmin, adminSessions.killSession);

// POST /api/admin/sessions/kill-others
router.post('/kill-others', requireAuth, requireAdmin, adminSessions.killOtherSessions);

module.exports = router;
