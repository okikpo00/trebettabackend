// controllers/adminSettingsController.js
const { getSettingsCached, updateSettings } = require('../services/settingsService');
const { auditLog } = require('../utils/auditLog');
const logger = require('../utils/logger');

exports.getSettings = async (req, res) => {
  try {
    console.log('adminSettingsController.getSettings › adminId:', req.user?.id);
    const settings = await getSettingsCached();
    return res.json({ status: true, data: settings });
  } catch (err) {
    logger.error('adminSettingsController.getSettings err', err);
    return res.status(500).json({
      status: false,
      message: 'Failed to fetch system settings',
      error: err.message
    });
  }
};

exports.updateSettings = async (req, res) => {
  const adminId = req.user?.id;
  console.log('adminSettingsController.updateSettings › adminId:', adminId, 'body:', req.body);

  try {
    const { before, after } = await updateSettings(req.body || {}, adminId);

    try {
      await auditLog(
        null,
        adminId,
        'SYSTEM_SETTINGS_UPDATED',
        'system_settings',
        after.id,
        { before, after }
      );
    } catch (aErr) {
      logger.warn('adminSettingsController.updateSettings › auditLog failed', aErr);
    }

    return res.json({
      status: true,
      message: 'Settings updated successfully',
      data: after
    });
  } catch (err) {
    logger.error('adminSettingsController.updateSettings err', err);
    return res.status(400).json({
      status: false,
      message: err.message || 'Failed to update system settings'
    });
  }
};
