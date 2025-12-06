// src/routes/winnerTickerRoutes.js
const express = require('express');
const router = express.Router();
const tickerCtrl = require('../controllers/winnerTickerController');

// Public top winners (frontend homepage)
router.get('/ticker', tickerCtrl.listPublic);

module.exports = router;