// controllers/adminWithdrawalController.js
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');
const generateReference = require('../utils/generateReference');
const createTransactionRecord = require('../utils/createTransactionRecord');
const { auditLog } = require('../utils/auditLog');
let notify = {};
try { notify = require('../utils/notify'); } catch (e) { /* optional */ }

/**
 * LIST ALL WITHDRAWALS (formatted for frontend)
 * GET /admin/withdrawals
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
      clauses.push('DATE(wr.requested_at) BETWEEN ? AND ?'); params.push(from, to);
    } else if (from) {
      clauses.push('DATE(wr.requested_at) >= ?'); params.push(from);
    } else if (to) {
      clauses.push('DATE(wr.requested_at) <= ?'); params.push(to);
    }

    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

    // count
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM withdrawal_requests wr
       LEFT JOIN users u ON u.id = wr.user_id
       ${where}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [rows] = await pool.query(
      `SELECT
         wr.id, wr.user_id, wr.wallet_id, wr.amount, wr.fee, wr.currency, wr.status,
         wr.reference, wr.bank_name, wr.account_number, wr.account_name,
         wr.requested_at, wr.processed_at, wr.completed_at, wr.metadata, wr.reviewed_by,
         u.username, u.email
       FROM withdrawal_requests wr
       LEFT JOIN users u ON u.id = wr.user_id
       ${where}
       ORDER BY wr.requested_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    // clean rows for frontend
    const data = rows.map(r => {
      let metadata = {};
      try { metadata = r.metadata ? JSON.parse(r.metadata) : {}; } catch (e) { metadata = {}; }

      const payout_amount = Number(r.amount) - Number(r.fee || 0);

      return {
        id: r.id,
        user_id: r.user_id,
        user: { username: r.username, email: r.email },
        wallet_id: r.wallet_id,
        amount: Number(r.amount),
        fee: Number(r.fee || 0),
        payout_amount,
        currency: r.currency || 'NGN',
        status: r.status,
        reference: r.reference,
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
    console.error('listAllWithdrawals err', err);
    return res.status(500).json({ status: false, message: 'Server error', error: err.message });
  }
}

/**
 * APPROVE WITHDRAWAL (Manual payout)
 * POST /admin/withdrawals/:id/approve
 *
 * Contract (Option A):
 * - Admin approves a request that must already be in status = 'processing'
 *   (meaning user already verified OTP and wallet was debited).
 * - Admin approves => mark request completed. DO NOT touch wallets.
 */
async function approveWithdrawal(req, res) {
  const adminId = req.user?.id;
  const id = Number(req.params.id);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Lock withdrawal row
    const [wrRows] = await conn.query('SELECT * FROM withdrawal_requests WHERE id = ? FOR UPDATE', [id]);
    if (!wrRows.length) {
      await conn.rollback();
      return res.status(404).json({ status: false, message: 'Withdrawal not found' });
    }
    const wr = wrRows[0];

    // Only allow approving processing requests (user already confirmed / debited)
    if (wr.status !== 'processing') {
      await conn.rollback();
      return res.status(400).json({
        status: false,
        message: `Withdrawal must be in 'processing' state to approve. Current status: ${wr.status}`
      });
    }

    // Generate payout reference for admin record (not a payment provider call)
    const payoutReference = `PAY-${Date.now()}-${uuidv4().slice(0,8)}`;

    // Update request to completed
    await conn.query(
      `UPDATE withdrawal_requests
       SET status = 'completed',
           reviewed_by = ?,
           processed_at = COALESCE(processed_at, NOW()),
           completed_at = NOW(),
           metadata = JSON_SET(IFNULL(metadata, '{}'), '$.admin_payout_reference', ?)
       WHERE id = ?`,
      [adminId, payoutReference, id]
    );

    // Audit log
    await auditLog(adminId, wr.user_id, 'ADMIN_APPROVE_WITHDRAWAL', 'withdrawal_requests', id, {
      admin: adminId,
      payout_reference: payoutReference,
      amount: Number(wr.amount),
      fee: Number(wr.fee || 0)
    });

    // Notify user (best-effort)
    try {
      if (typeof notify === 'function') {
        await notify(wr.user_id, 'Withdrawal approved', `Your withdrawal ${wr.reference} of ₦${Number(wr.amount)} has been approved by admin.`);
      } else if (notify && notify.sendEmail && wr.user_id) {
        // optional fallback if notify helper provides explicit methods
        // noop - keep safe
      }
    } catch (nerr) {
      console.warn('approveWithdrawal notify error', nerr);
    }

    await conn.commit();

    return res.json({
      status: true,
      message: 'Withdrawal approved and marked completed',
      data: { id, reference: wr.reference, payout_reference: payoutReference }
    });
  } catch (err) {
    await conn.rollback();
    console.error('approveWithdrawal err', err);
    return res.status(500).json({ status: false, message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
}

/**
 * REJECT WITHDRAWAL
 * POST /admin/withdrawals/:id/reject
 *
 * Behavior:
 * - If status = 'pending' → just mark rejected (wallet not debited yet).
 * - If status = 'processing' → refund the debited amount back to wallet and mark rejected.
 * - If status = 'completed' or already 'rejected' → prevent action.
 */
async function rejectWithdrawal(req, res) {
  const adminId = req.user?.id;
  const id = Number(req.params.id);
  const { reason } = req.body || {};

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [wrRows] = await conn.query('SELECT * FROM withdrawal_requests WHERE id = ? FOR UPDATE', [id]);
    if (!wrRows.length) {
      await conn.rollback();
      return res.status(404).json({ status: false, message: 'Withdrawal not found' });
    }
    const wr = wrRows[0];

    if (['completed', 'rejected', 'failed'].includes(wr.status)) {
      await conn.rollback();
      return res.status(400).json({ status: false, message: `Cannot reject withdrawal in status '${wr.status}'` });
    }

    // If it was processing, it means wallet already debited — refund
    if (wr.status === 'processing') {
      // Get wallet row FOR UPDATE
      const [walletRows] = await conn.query('SELECT id, balance FROM wallets WHERE id = ? FOR UPDATE', [wr.wallet_id]);
      if (!walletRows.length) {
        await conn.rollback();
        return res.status(404).json({ status: false, message: 'Associated wallet not found for refund' });
      }
      const wallet = walletRows[0];
      const balanceBefore = Number(wallet.balance || 0);
      const refundAmount = Number(wr.amount || 0);

      const balanceAfter = Number((balanceBefore + refundAmount).toFixed(2));

      // Update wallet balance
      await conn.query('UPDATE wallets SET balance = ?, updated_at = NOW() WHERE id = ?', [balanceAfter, wallet.id]);

      // Create transaction record for refund
      const refundReference = generateReference('REFUND');
      await createTransactionRecord(conn, {
        user_id: wr.user_id,
        wallet_id: wallet.id,
        type: 'refund',
        amount: refundAmount,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        reference: refundReference,
        description: `Refund for rejected withdrawal ${wr.reference}`,
        provider: 'manual',
        admin_id: adminId,
        status: 'completed'
      });

      // Mark withdrawal as rejected and record refund info
      await conn.query(
        `UPDATE withdrawal_requests
         SET status = 'rejected',
             rejection_reason = ?,
             reviewed_by = ?,
             processed_at = COALESCE(processed_at, NOW()),
             metadata = JSON_SET(IFNULL(metadata, '{}'), '$.refund_reference', ?, '$.refund_amount', ?),
             updated_at = NOW()
         WHERE id = ?`,
        [reason || 'Rejected by admin', adminId, refundReference, refundAmount, id]
      );

      // audit
      await auditLog(adminId, wr.user_id, 'ADMIN_REJECT_WITHDRAWAL_REFUNDED', 'withdrawal_requests', id, {
        admin: adminId,
        reason: reason || null,
        refund_reference: refundReference,
        refund_amount: refundAmount
      });

      // Notify user
      try {
        if (typeof notify === 'function') {
          await notify(wr.user_id, 'Withdrawal rejected & refunded', `Your withdrawal ${wr.reference} has been rejected and ₦${refundAmount} refunded to your wallet. Reason: ${reason || 'No reason provided'}`);
        }
      } catch (nerr) {
        console.warn('rejectWithdrawal notify error', nerr);
      }

      await conn.commit();
      return res.json({
        status: true,
        message: 'Withdrawal rejected and refunded',
        data: { id, refund_reference: refundReference, refund_amount: refundAmount }
      });
    }

    // If status === 'pending' (user didn't confirm OTP / not debited): just mark rejected
    await conn.query(
      `UPDATE withdrawal_requests
       SET status = 'rejected',
           rejection_reason = ?,
           reviewed_by = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [reason || 'Rejected by admin', adminId, id]
    );

    await auditLog(adminId, wr.user_id, 'ADMIN_REJECT_WITHDRAWAL', 'withdrawal_requests', id, {
      admin: adminId,
      reason: reason || null
    });

    try {
      if (typeof notify === 'function') {
        await notify(wr.user_id, 'Withdrawal rejected', `Your withdrawal ${wr.reference} has been rejected. Reason: ${reason || 'No reason provided'}`);
      }
    } catch (nerr) {
      console.warn('rejectWithdrawal notify error', nerr);
    }

    await conn.commit();
    return res.json({ status: true, message: 'Withdrawal rejected' });

  } catch (err) {
    await conn.rollback();
    console.error('rejectWithdrawal err', err);
    return res.status(500).json({ status: false, message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
}

module.exports = { listAllWithdrawals, approveWithdrawal, rejectWithdrawal };
