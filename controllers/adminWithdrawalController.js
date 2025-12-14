// controllers/adminWithdrawalController.js
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const generateReference = require('../utils/generateReference');
const createTransactionRecord = require('../utils/createTransactionRecord');
const { auditLog } = require('../utils/auditLog');

let notify;
try { notify = require('../utils/notify'); } catch { notify = null; }

/**
 * ---------------------------------------------------------
 * LIST ALL WITHDRAWALS (ADMIN)
 * ---------------------------------------------------------
 */
async function listAllWithdrawals(req, res) {
  try {
    const {
      status,
      user_id,
      reference,
      from,
      to,
      page = 1,
      limit = 50
    } = req.query;

    const offset = (page - 1) * limit;
    const clauses = [];
    const params = [];

    if (status) { clauses.push('wr.status = ?'); params.push(status); }
    if (user_id) { clauses.push('wr.user_id = ?'); params.push(user_id); }
    if (reference) { clauses.push('wr.reference LIKE ?'); params.push(`%${reference}%`); }
    if (from && to) {
      clauses.push('DATE(wr.requested_at) BETWEEN ? AND ?');
      params.push(from, to);
    } else if (from) {
      clauses.push('DATE(wr.requested_at) >= ?');
      params.push(from);
    } else if (to) {
      clauses.push('DATE(wr.requested_at) <= ?');
      params.push(to);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM withdrawal_requests wr ${where}`,
      params
    );

    const [rows] = await pool.query(
      `SELECT
        wr.*,
        u.username,
        u.email
       FROM withdrawal_requests wr
       LEFT JOIN users u ON u.id = wr.user_id
       ${where}
       ORDER BY wr.requested_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    const data = rows.map(r => {
      let metadata = {};
      try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch {}

      return {
        id: r.id,
        reference: r.reference,
        user: {
          id: r.user_id,
          username: r.username,
          email: r.email
        },
        amount: Number(r.amount),
        fee: Number(r.fee || 0),
        payout_amount: Number(r.amount) - Number(r.fee || 0),
        status: r.status,
        bank: {
          bank_name: r.bank_name,
          account_number: r.account_number,
          account_name: r.account_name
        },
        metadata,
        requested_at: r.requested_at,
        processed_at: r.processed_at,
        completed_at: r.completed_at,
        reviewed_by: r.reviewed_by
      };
    });

    return res.json({
      status: true,
      data,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        page_count: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('listAllWithdrawals error', err);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
}

/**
 * ---------------------------------------------------------
 * APPROVE WITHDRAWAL
 * ---------------------------------------------------------
 */
async function approveWithdrawal(req, res) {
  const adminId = req.user.id;
  const id = Number(req.params.id);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT * FROM withdrawal_requests WHERE id = ? FOR UPDATE',
      [id]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ status: false, message: 'Withdrawal not found' });
    }

    const wr = rows[0];

    if (wr.status !== 'processing') {
      await conn.rollback();
      return res.status(400).json({
        status: false,
        message: `Only processing withdrawals can be approved`
      });
    }

    const payoutRef = `PAY-${Date.now()}-${uuidv4().slice(0, 8)}`;

    await conn.query(
      `UPDATE withdrawal_requests
       SET status = 'completed',
           reviewed_by = ?,
           completed_at = NOW(),
           metadata = JSON_SET(IFNULL(metadata, '{}'), '$.admin_payout_reference', ?)
       WHERE id = ?`,
      [adminId, payoutRef, id]
    );

    await auditLog(
      adminId,
      wr.user_id,
      'ADMIN_APPROVE_WITHDRAWAL',
      'withdrawal_requests',
      id,
      { payout_reference: payoutRef }
    );

    await conn.commit();

    if (notify) {
      notify({
        userId: wr.user_id,
        title: 'Withdrawal completed',
        message: `Your withdrawal ${wr.reference} has been completed successfully.`,
        type: 'withdrawal',
        severity: 'success',
        metadata: { reference: wr.reference }
      }).catch(() => {});
    }

    return res.json({
      status: true,
      message: 'Withdrawal approved and completed'
    });
  } catch (err) {
    await conn.rollback();
    console.error('approveWithdrawal error', err);
    return res.status(500).json({ status: false, message: 'Server error' });
  } finally {
    conn.release();
  }
}

/**
 * ---------------------------------------------------------
 * REJECT WITHDRAWAL
 * ---------------------------------------------------------
 */
async function rejectWithdrawal(req, res) {
  const adminId = req.user.id;
  const id = Number(req.params.id);
  const { reason } = req.body || {};

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      'SELECT * FROM withdrawal_requests WHERE id = ? FOR UPDATE',
      [id]
    );
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ status: false, message: 'Withdrawal not found' });
    }

    const wr = rows[0];

    if (['completed', 'rejected'].includes(wr.status)) {
      await conn.rollback();
      return res.status(400).json({ status: false, message: 'Cannot reject this withdrawal' });
    }

    // REFUND if already debited
    if (wr.status === 'processing') {
      const [[wallet]] = await conn.query(
        'SELECT id, balance FROM wallets WHERE id = ? FOR UPDATE',
        [wr.wallet_id]
      );

      const refundAmount = Number(wr.amount);
      const balanceBefore = Number(wallet.balance);
      const balanceAfter = balanceBefore + refundAmount;

      await conn.query(
        'UPDATE wallets SET balance = ? WHERE id = ?',
        [balanceAfter, wallet.id]
      );

      const refundRef = generateReference('REFUND');

      await createTransactionRecord(conn, {
        user_id: wr.user_id,
        wallet_id: wallet.id,
        type: 'refund',
        amount: refundAmount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        reference: refundRef,
        description: `Refund for withdrawal ${wr.reference}`,
        admin_id: adminId,
        status: 'completed'
      });

      await conn.query(
        `UPDATE withdrawal_requests
         SET status = 'rejected',
             rejection_reason = ?,
             reviewed_by = ?,
             metadata = JSON_SET(
               IFNULL(metadata, '{}'),
               '$.refund_reference', ?,
               '$.refund_amount', ?
             )
         WHERE id = ?`,
        [reason || 'Rejected', adminId, refundRef, refundAmount, id]
      );
    } else {
      // pending → no refund
      await conn.query(
        `UPDATE withdrawal_requests
         SET status = 'rejected',
             rejection_reason = ?,
             reviewed_by = ?
         WHERE id = ?`,
        [reason || 'Rejected', adminId, id]
      );
    }

    await auditLog(
      adminId,
      wr.user_id,
      'ADMIN_REJECT_WITHDRAWAL',
      'withdrawal_requests',
      id,
      { reason }
    );

    await conn.commit();

    if (notify) {
      notify({
        userId: wr.user_id,
        title: 'Withdrawal rejected',
        message: `Your withdrawal ${wr.reference} was rejected. ${reason || ''}`,
        type: 'withdrawal',
        severity: 'warning'
      }).catch(() => {});
    }

    return res.json({ status: true, message: 'Withdrawal rejected' });
  } catch (err) {
    await conn.rollback();
    console.error('rejectWithdrawal error', err);
    return res.status(500).json({ status: false, message: 'Server error' });
  } finally {
    conn.release();
  }
}

module.exports = {
  listAllWithdrawals,
  approveWithdrawal,
  rejectWithdrawal
};
