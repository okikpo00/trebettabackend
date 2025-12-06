// controllers/winnerController.js
const pool = require('../config/db');

// public: latest approved ticker items
exports.latestTicker = async (req, res) => {
  const limit = Number(req.query.limit) || 10;
  try {
    const [rows] = await pool.query(
      `SELECT q.id, q.ticket_id, q.message, q.amount, q.approved_at
       FROM winner_ticker_queue q
       WHERE q.approved = 1
       ORDER BY q.approved_at DESC
       LIMIT ?`, [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('latestTicker err', err);
    res.status(500).json({ message: 'Server error' });
  }
};

// admin: list pending queue items
exports.pendingQueue = async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT q.*, t.ticket_code, t.user_id FROM winner_ticker_queue q
       JOIN winner_tickets t ON t.id = q.ticket_id
       WHERE q.approved = 0
       ORDER BY q.created_at ASC`
    );
    res.json(rows);
  } catch (err) {
    console.error('pendingQueue err', err);
    res.status(500).json({ message: 'Server error' });
  }
};
