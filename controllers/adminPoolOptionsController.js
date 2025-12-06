// src/controllers/adminPoolOptionsController.js
const poolService = require('../services/poolService');
const poolOptionService = require('../services/poolOptionService');
const { respond } = require ('../utils/responseHandler');
const  logger  = require('../utils/logger');

exports.addOption = async (req, res) => {
  try {
    const { pool_id } = req.params;
    const { title } = req.body;

    if (!pool_id || !title)
      return respond(res, false, 'Pool ID and title required', 400);

    const newOption = await poolOptionService.createOption(pool_id, title);
    return respond(res, true, 'Option added successfully', 201, newOption);
  } catch (err) {
    logger.error('addOption error', err);
    return respond(res, false, 'Server error', 500);
  }
};

exports.updateOption = async (req, res) => {
  try {
    const { pool_id, option_id } = req.params;
    const { title } = req.body;

    if (!option_id) return respond(res, false, 'Option ID required', 400);

    const updated = await poolOptionService.updateOption(pool_id, option_id, title);
    return respond(res, true, 'Option updated successfully', 200, updated);
  } catch (err) {
    logger.error('updateOption error', err);
    return respond(res, false, 'Server error', 500);
  }
};

exports.deleteOption = async (req, res) => {
  try {
    const { pool_id, option_id } = req.params;

    const deleted = await poolOptionService.deleteOption(pool_id, option_id);
    return respond(res, true, 'Option deleted successfully', 200, deleted);
  } catch (err) {
    logger.error('deleteOption error', err);
    return respond(res, false, 'Server error', 500);
  }
};



exports.eliminateOption = async (req, res) => {
  try {
    const { pool_id, option_id } = req.body;

    if (!pool_id || !option_id)
      return respond(res, false, 'Pool ID and Option ID are required', 400);

    logger.info(`🧩 Admin eliminating option ${option_id} from pool ${pool_id}`);

    const result = await poolOptionService.eliminateOption(pool_id, option_id);

    return respond(res, true, result.message, 200, result);
  } catch (err) {
    logger.error('❌ eliminateOption controller error:', err);
    return respond(res, false, err.message || 'Server error', 500);
  }
};


