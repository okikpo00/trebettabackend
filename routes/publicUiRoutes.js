// routes/publicUiRoutes.js
const express = require('express');
const router = express.Router();
const winnerController = require('../controllers/winnerController');
const billboardController = require('../controllers/billboardController');

router.get('/ticker/latest', winnerController.latestTicker);
router.get('/billboard/active', billboardController.publicActive);

module.exports = router;
