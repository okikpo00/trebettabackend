// routes/adminTransactionRoutes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/adminTransactionController');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');

router.get('/export', requireAuth, requireAdmin, controller.exportTransactionsCSV);
router.get('/', requireAuth, requireAdmin, controller.listTransactions);
router.get('/:id', requireAuth, requireAdmin, controller.getTransaction);
router.post('/verify/:reference', requireAuth, requireAdmin, controller.verifyTransaction);
router.post('/reverse/:id', requireAuth, requireAdmin, controller.reverseTransaction);

module.exports = router;
