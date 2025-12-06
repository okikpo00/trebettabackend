const userBillboardService = require('../services/userBillboardService');
const logger = require('../utils/logger');

exports.getBillboards = async (req, res) => {
  try {
    const billboards = await userBillboardService.getActiveBillboards();
    return res.json({ status: true, data: billboards });
  } catch (e) {
    logger.error('Error fetching billboards:', e);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
};
