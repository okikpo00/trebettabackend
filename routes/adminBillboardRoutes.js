// src/routes/adminBillboardRoutes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminBillboardController');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

router.post('/', requireAuth, requireAdmin, controller.create);
router.put('/:id', requireAuth, requireAdmin, controller.update);
router.delete('/:id', requireAuth, requireAdmin, controller.delete);
router.get('/', requireAuth, requireAdmin, controller.list);

module.exports = router;
