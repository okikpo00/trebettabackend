// controllers/billboardController.js
const pool = require('../config/db');

exports.publicActive = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, title, body, image_url, link_type, link_ref FROM billboard_cards
       WHERE status = 'ACTIVE'
       ORDER BY priority ASC, created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error('publicActive err', err);
    res.status(500).json({ message: 'Server error' });
  }
};
