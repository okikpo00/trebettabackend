// controllers/slipController.js
const slipService = require('../services/slipService');
const logger = require('../utils/logger');

// ---------------------------------------------------------
// GET SLIP BY ID
// ---------------------------------------------------------
exports.getSlip = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ status: false, message: 'Unauthorized' });
    }

    const userId = req.user.id;
    const slipId = (req.params.slipId || '').trim();

    console.log('[SLIP] getSlip › user:', userId, 'slipId:', slipId);

    if (!slipId) {
      return res.status(400).json({ status: false, message: 'Invalid slip id' });
    }

    const slip = await slipService.getSlipForUser(slipId, userId);

    if (!slip) {
      return res.status(404).json({ status: false, message: 'Slip not found' });
    }

    return res.json({
      status: true,
      data: slip
    });
  } catch (err) {
    logger && logger.error && logger.error('getSlip ERROR', err);
    return res.status(500).json({
      status: false,
      message: 'Server error',
      error: err.message
    });
  }
};
