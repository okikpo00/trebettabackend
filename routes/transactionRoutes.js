// backend/routes/transactionRoutes.js
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/auth'); // <-- correct import

const transactionController = require('../controllers/transactionController');

router.post('/deposit', requireAuth, transactionController.deposit);
router.post('/withdraw', requireAuth, transactionController.withdraw);
router.post('/transfer', requireAuth, transactionController.transfer);
router.get('/', requireAuth, transactionController.getTransactions);

module.exports = router;
