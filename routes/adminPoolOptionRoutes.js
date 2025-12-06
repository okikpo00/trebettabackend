// src/routes/adminPoolOptionRoutes.js
const express = require('express');
const router = express.Router();
const adminMiddleware = require('../middleware/requireAdmin');
const adminPoolOptionsController = require('../controllers/adminPoolOptionsController');

// All routes below require admin authentication
router.use(adminMiddleware);

// Add a new pool option
router.post('/:pool_id/options', adminPoolOptionsController.addOption);

// Update a pool option
router.put('/:pool_id/options/:option_id', adminPoolOptionsController.updateOption);

// Delete a pool option
router.delete('/:pool_id/options/:option_id', adminPoolOptionsController.deleteOption);

// Eliminate (soft delete) a pool option
router.post('/eliminate', adminPoolOptionsController.eliminateOption);

// Get all pool options
router.get('/:pool_id/options', async (req, res, next) => {
  try {
    const poolOptionService = require('../services/poolOptionService');
    const { pool_id } = req.params;
    const options = await poolOptionService.getPoolOptions(pool_id);
    res.status(200).json({ status: true, data: options });
  } catch (err) {
    next(err);
  }
});

module.exports = router;