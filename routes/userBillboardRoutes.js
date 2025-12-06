const express = require('express');
const router = express.Router();
const userBillboardController = require('../controllers/userBillboardController');

// ✅ Route for user-facing billboards
router.get('/', userBillboardController.getBillboards);

module.exports = router;
