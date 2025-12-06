// routes/slipRoutes.js
const express = require('express');
const router = express.Router();

const requireAuth = require('../middleware/auth');
const slipController = require('../controllers/slipController');

// GET /api/slip/:slipId
router.get('/:slipId', requireAuth, slipController.getSlip);

module.exports = router;
