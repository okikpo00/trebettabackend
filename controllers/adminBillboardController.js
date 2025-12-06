const path = require('path');
const billboardService = require('../services/billboardService');
const logger = require('../utils/logger');

// --- Debug block (keep this for now) ---
console.log('✅ BillboardService loaded from:', require.resolve('../services/billboardService'));
console.log('🧩 BillboardService keys:', Object.keys(billboardService));
// ---------------------------------------

exports.create = async (req, res) => {
  try {
    const { title, image_url, video_url, redirect_link, description, is_active } = req.body;
    if (!title) return res.status(400).json({ status: false, message: 'title required' });

    const r = await billboardService.createBillboard({
      title,
      image_url,
      video_url,
      redirect_link,
      description,
      is_active,
    });

    return res.status(201).json({ status: true, data: r });
  } catch (err) {
    logger.error('admin.createBillboard err', err);
    return res
      .status(500)
      .json({ status: false, message: 'Server error', error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const updates = req.body;
    const r = await billboardService.updateBillboard(id, updates);
    return res.json({ status: true, data: r });
  } catch (err) {
    logger.error('admin.updateBillboard err', err);
    return res
      .status(500)
      .json({ status: false, message: 'Server error', error: err.message });
  }
};

exports.delete = async (req, res) => {
  try {
    const id = Number(req.params.id);
    const r = await billboardService.deleteBillboard(id);
    return res.json({ status: true, data: r });
  } catch (err) {
    logger.error('admin.deleteBillboard err', err);
    return res
      .status(500)
      .json({ status: false, message: 'Server error', error: err.message });
  }
};

exports.list = async (req, res) => {
  try {
    const rows = await billboardService.listBillboards({ onlyActive: false });
    return res.json({ status: true, data: rows });
  } catch (err) {
    logger.error('admin.listBillboards err', err);
    return res
      .status(500)
      .json({ status: false, message: 'Server error', error: err.message });
  }
};
