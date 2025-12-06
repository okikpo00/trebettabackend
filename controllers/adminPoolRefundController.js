// src/controllers/adminPoolRefundController.js
const refundService = require('../services/refundService');
const logger = require('../utils/logger');

exports.refundPool = async (req, res) => {
  try {
    const adminId = req.user?.id || null;

    // poolId can come from route :id OR body.pool_id
    const poolIdRaw = req.params.id ?? req.body.pool_id;
    const poolId = Number(poolIdRaw);

    if (!poolId || isNaN(poolId)) {
      return res.status(400).json({
        status: false,
        message: 'Valid pool_id is required'
      });
    }

    // parse entry IDs
    let entryIds = null;
    if (Array.isArray(req.body.entries) && req.body.entries.length > 0) {
      entryIds = req.body.entries
        .map(v => Number(v))
        .filter(v => !isNaN(v) && v > 0);
      if (entryIds.length === 0) entryIds = null;
    }

    const reason = req.body.reason?.trim() || null;

    const result = await refundService.refundPoolEntries({
      poolId,
      entryIds,
      adminId,
      reason
    });

    let msg = '';
    if (result.refundedCount === 0) {
      msg = 'No refundable entries found';
    } else if (entryIds) {
      msg = `Partial refund completed for ${result.refundedCount} entries`;
    } else {
      msg = `Full refund completed for all ${result.refundedCount} entries`;
    }

    return res.json({
      status: true,
      message: msg,
      data: result
    });

  } catch (err) {
    logger.error('admin refundPool err', err);
    return res.status(500).json({
      status: false,
      message: 'Server error',
      error: err.message
    });
  }
};
