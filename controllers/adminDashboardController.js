const dashboardService = require('../services/dashboardService');
const logger = require('../utils/logger');

exports.overview = async (req, res) => {
  try {
    const data = await dashboardService.getOverview();
    res.json({ status: true, data });
  } catch (err) {
    logger.error('adminDashboardController.overview err', err);
    res.status(500).json({ status: false, message: 'Server error', error: err.message });
  }
};

exports.wallets = async (req, res) => {
  try {
    const data = await dashboardService.getWalletsSummary();
    res.json({ status: true, data });
  } catch (err) {
    logger.error('adminDashboardController.wallets err', err);
    res.status(500).json({ status: false, message: 'Server error', error: err.message });
  }
};

exports.pools = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Number(req.query.limit || 20));
    const data = await dashboardService.getPoolsSummary({ page, limit });
    res.json({ status: true, data });
  } catch (err) {
    logger.error('adminDashboardController.pools err', err);
    res.status(500).json({ status: false, message: 'Server error', error: err.message });
  }
};

exports.activity = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Number(req.query.limit || 50));
    const type = req.query.type || null;
    const data = await dashboardService.getActivityFeed({ page, limit, type });
    res.json({ status: true, data });
  } catch (err) {
    logger.error('adminDashboardController.activity err', err);
    res.status(500).json({ status: false, message: 'Server error', error: err.message });
  }
};
