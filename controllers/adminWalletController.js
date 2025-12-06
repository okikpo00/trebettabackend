// controllers/adminWalletController.js
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const { auditLog } = require('./_adminHelpers'); // your helper
const  createTransactionRecord  = require('../utils/createTransactionRecord'); // reuse
const notify = require("../utils/notify");
// GET /api/admin/wallets?search=&status=&page=&limit=
async function listWallets(req, res) {
  try {
    const { search, status, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const clauses = [];
    const params = [];

    if (search) {
      clauses.push('(u.username LIKE ? OR u.email LIKE ? OR w.id = ?)');
      params.push(`%${search}%`, `%${search}%`, search);
    }
    if (status) {
      clauses.push('w.status = ?');
      params.push(status);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const sql = `
      SELECT w.id AS wallet_id, w.user_id, w.balance, w.reserved_balance, w.currency, w.status, u.username, u.email
      FROM wallets w
      LEFT JOIN users u ON u.id = w.user_id
      ${where}
      ORDER BY w.updated_at DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await pool.query(sql, [...params, Number(limit), Number(offset)]);
    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM wallets w LEFT JOIN users u ON u.id = w.user_id ${where}`, params);
    return res.json({ data: rows, meta: { total: countRows[0].total, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('listWallets err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
}

// GET /api/admin/wallets/:id
async function getWallet(req, res) {
  try {
    const walletId = Number(req.params.id);
    if (!walletId) return res.status(400).json({ message: 'Invalid wallet id' });

    const [[walletRow]] = await pool.query(
      `SELECT w.*, u.username, u.email FROM wallets w LEFT JOIN users u ON u.id = w.user_id WHERE w.id = ? LIMIT 1`,
      [walletId]
    );
    if (!walletRow) return res.status(404).json({ message: 'Wallet not found' });

    const [txs] = await pool.query(`SELECT id, type, amount, status, reference, description, created_at FROM transactions WHERE wallet_id = ? ORDER BY created_at DESC LIMIT 100`, [walletId]);

    return res.json({ wallet: walletRow, transactions: txs });
  } catch (err) {
    console.error('getWallet err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
}

// POST /api/admin/wallets/credit/:id
// body: { amount, reason }
async function creditWallet(req, res) {
  const adminId = req.user?.id;
  const userId = Number(req.params.id);
  const { amount, reason } = req.body || {};
  if (!amount || Number(amount) <= 0) return res.status(400).json({ message: 'Invalid amount' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [wallets] = await conn.query('SELECT * FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
    if (!wallets.length) { await conn.rollback(); return res.status(404).json({ message: 'Wallet not found' }); }
    const wallet = wallets[0];
    const before = Number(wallet.balance || 0);
    const after = (before + Number(amount)).toFixed(2);

    await conn.query('UPDATE wallets SET balance = ?, updated_at = NOW() WHERE id = ?', [after, wallet.id]);

    const reference = `ADMIN_CR_${Date.now()}_${uuidv4().slice(0,8)}`;
    await createTransactionRecord(conn, {
      user_id: userId,
      wallet_id: wallet.id,
      type: 'admin_credit',
      amount: Number(amount),
      balance_before: before,
      balance_after: Number(after),
      reference,
      reason: reason || 'Admin credit',
      admin_id: adminId,
      status: 'completed'
    });

    // audit & notify
    await auditLog(conn, adminId, 'WALLET_CREDIT', 'wallet', wallet.id, { user_id: userId, amount, reference });
    await conn.commit();

    // async notify (do not block)
    try { notify(userId, 'Wallet credited', `Your wallet was credited with ${amount}. Reason: ${reason || 'Admin credit'}`, { type: 'wallet_credit', amount, reference }); } catch(e) {}
    try { notify(userId, 'Wallet Credited', `Your wallet was credited with ${amount}. Reference: ${reference}`); } catch(e){}

    return res.json({ message: 'Wallet credited', wallet_id: wallet.id, before, after, reference });
  } catch (err) {
    await conn.rollback();
    console.error('creditWallet err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
}

// POST /api/admin/wallets/debit/:id
// body: { amount, reason }
async function debitWallet(req, res) {
  const adminId = req.user?.id;
  const userId = Number(req.params.id);
  const { amount, reason } = req.body || {};
  if (!amount || Number(amount) <= 0) return res.status(400).json({ message: 'Invalid amount' });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [wallets] = await conn.query('SELECT * FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
    if (!wallets.length) { await conn.rollback(); return res.status(404).json({ message: 'Wallet not found' }); }
    const wallet = wallets[0];

    const before = Number(wallet.balance || 0);
    if (before < Number(amount)) { await conn.rollback(); return res.status(400).json({ message: 'Insufficient wallet balance' }); }

    const after = (before - Number(amount)).toFixed(2);
    await conn.query('UPDATE wallets SET balance = ?, updated_at = NOW() WHERE id = ?', [after, wallet.id]);

    const reference = `ADMIN_DB_${Date.now()}_${uuidv4().slice(0,8)}`;
    await createTransactionRecord(conn, {
      user_id: userId,
      wallet_id: wallet.id,
      type: 'admin_debit',
      amount: Number(amount),
      balance_before: before,
      balance_after: Number(after),
      reference,
      reason: reason || 'Admin debit',
      admin_id: adminId,
      status: 'completed'
    });

    await auditLog(conn, adminId, 'WALLET_DEBIT', 'wallet', wallet.id, { user_id: userId, amount, reference });
    await conn.commit();

    try { notify(userId, 'Wallet debited', `Your wallet was debited with ${amount}. Reason: ${reason || 'Admin debit'}`, { type: 'wallet_debit', amount, reference }); } catch(e){}
    try { notify(userId, 'Wallet Debited', `Your wallet was debited with ${amount}. Reference: ${reference}`); } catch(e){}

    return res.json({ message: 'Wallet debited', wallet_id: wallet.id, before, after, reference });
  } catch (err) {
    await conn.rollback();
    console.error('debitWallet err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
}

// PATCH freeze/unfreeze
// PATCH /api/admin/wallets/freeze/:id  body { reason }
// PATCH /api/admin/wallets/unfreeze/:id body { reason }
async function setWalletStatus(req, res) {
  const adminId = req.user?.id;
  const userId = Number(req.params.id);
  const action = req.path.includes('/freeze') ? 'freeze' : 'unfreeze';
  const reason = req.body.reason || null;

  try {
    const status = action === 'freeze' ? 'frozen' : 'active';
    const [[walletRow]] = await pool.query('SELECT * FROM wallets WHERE user_id = ? LIMIT 1', [userId]);
    if (!walletRow) return res.status(404).json({ message: 'Wallet not found' });

    await pool.query('UPDATE wallets SET status = ?, updated_at = NOW() WHERE id = ?', [status, walletRow.id]);
    await auditLog(pool, adminId, action === 'freeze' ? 'WALLET_FREEZE' : 'WALLET_UNFREEZE', 'wallet', walletRow.id, { reason });

    try { notify(userId, `Your wallet has been ${status}`, { type: 'wallet_status', status, reason }); } catch(e){}
    try { notify(userId, `Wallet ${status}`, `Your wallet status changed to ${status}. Reason: ${reason || 'N/A'}`); } catch(e){}

    return res.json({ message: `Wallet ${status}`, wallet_id: walletRow.id });
  } catch (err) {
    console.error('setWalletStatus err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
}

module.exports = { listWallets, getWallet, creditWallet, debitWallet, setWalletStatus };

