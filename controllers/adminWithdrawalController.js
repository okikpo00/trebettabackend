// controllers/adminWithdrawalController.js
const pool = require('../config/db');
const { auditLog, createTransactionRecord } = require('./_adminHelpers');
const notify = require("../utils/notify");

const { v4: uuidv4 } = require('uuid');

async function listAllWithdrawals(req, res) {
  const { status, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  const clauses = [];
  const params = [];

  if (status) { 
    clauses.push('wr.status = ?'); 
    params.push(status); 
  }

  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  try {
    const [rows] = await pool.query(
      `
      SELECT 
        wr.*,
        u.username
      FROM withdrawal_requests wr
      LEFT JOIN users u ON u.id = wr.user_id
      ${where}
      ORDER BY wr.requested_at DESC
      LIMIT ? OFFSET ?
      `,
      [...params, Number(limit), offset]
    );

    return res.json({ data: rows });
  } catch (err) {
    console.error('listAllWithdrawals err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
}

async function approveWithdrawal(req, res) {
  const adminId = req.user?.id;
  const id = req.params.id;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [wr] = await conn.query('SELECT * FROM withdrawal_requests WHERE id = ? FOR UPDATE', [id]);
    if (!wr.length) { await conn.rollback(); return res.status(404).json({ message: 'Withdrawal not found' }); }
    const request = wr[0];

    if (!['pending_approval','pending'].includes(request.status)) {
      await conn.rollback();
      return res.status(400).json({ message: 'Withdrawal not pending approval' });
    }

    const [walletRows] = await conn.query('SELECT * FROM wallets WHERE id = ? FOR UPDATE', [request.wallet_id]);
    if (!walletRows.length) { await conn.rollback(); return res.status(404).json({ message: 'Wallet not found' }); }
    const wallet = walletRows[0];

    // check if already debited (rare)
    const balanceBefore = Number(wallet.balance);
    const fee = Number(request.fee || 0) || 0;
    const debit = Number(request.amount) + fee;
    if (balanceBefore < debit) { await conn.rollback(); return res.status(400).json({ message: 'Insufficient wallet funds' }); }

    const newBalance = (balanceBefore - debit).toFixed(2);
    await conn.query('UPDATE wallets SET balance = ? WHERE id = ?', [newBalance, wallet.id]);

    const reference = request.reference || `WD-${Date.now()}-${uuidv4().slice(0,8)}`;
    await conn.query(
      `UPDATE withdrawal_requests
       SET status = 'processing', processed_at = NOW(), reviewed_by = ?, balance_before = ?, balance_after = ?
       WHERE id = ?`,
      [adminId, balanceBefore, newBalance, id]
    );

    // create transaction
    await createTransactionRecord(conn, {
      user_id: request.user_id,
      wallet_id: wallet.id,
      type: 'withdrawal',
      amount: request.amount,
      balance_before: balanceBefore,
      balance_after: Number(newBalance),
      reference,
      description: `Admin approved withdrawal ${reference}`,
      admin_id: adminId,
      status: 'processing'
    });

    // For now mark completed (real integration should call payout provider and update)
    await conn.query('UPDATE withdrawal_requests SET status = ? WHERE id = ?', ['completed', id]);

    await auditLog(conn, adminId, 'APPROVE_WITHDRAWAL', 'withdrawal_request', id, { adminId, reference });
    await notify(request.user_id, 'Withdrawal approved', `Your withdrawal ${reference} has been approved`, { type: 'withdrawal', id });

    await conn.commit();
    return res.json({ message: 'Withdrawal approved', id, reference, new_balance: newBalance });
  } catch (err) {
    await conn.rollback();
    console.error('approveWithdrawal err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
}

async function rejectWithdrawal(req, res) {
  const adminId = req.user?.id;
  const id = req.params.id;
  const { reason } = req.body || {};
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [wr] = await conn.query('SELECT * FROM withdrawal_requests WHERE id = ? FOR UPDATE', [id]);
    if (!wr.length) { await conn.rollback(); return res.status(404).json({ message: 'Withdrawal not found' }); }
    const request = wr[0];
    if (!['pending_approval','pending'].includes(request.status)) {
      await conn.rollback();
      return res.status(400).json({ message: 'Only pending_approval or pending can be rejected' });
    }

    // update status to rejected
    await conn.query('UPDATE withdrawal_requests SET status = ?, rejection_reason = ?, reviewed_by = ?, processed_at = NOW() WHERE id = ?', ['rejected', reason || 'Rejected by admin', adminId, id]);

    await auditLog(conn, adminId, 'REJECT_WITHDRAWAL', 'withdrawal_request', id, { reason });
    await notify(request.user_id, 'Withdrawal rejected', `Your withdrawal ${request.reference} has been rejected. Reason: ${reason || 'No reason provided'}`, { type: 'withdrawal', id });

    await conn.commit();
    return res.json({ message: 'Withdrawal rejected', id });
  } catch (err) {
    await conn.rollback();
    console.error('rejectWithdrawal err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
}

module.exports = { listAllWithdrawals, approveWithdrawal, rejectWithdrawal };
