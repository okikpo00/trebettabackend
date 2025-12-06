// src/controllers/homeController.js
const homeService = require('../services/homeService');
const logger = require('../utils/logger');

exports.home = async (req, res) => {
  try {
    const payload = await homeService.getHomePayload();
    return res.json({ status: true, data: payload });
  } catch (err) {
    logger.error('home err', err);
    return res.status(500).json({ status: false, message: 'Server error', error: err.message });
  }
};
