// controllers/depositMatchAdminController.js
const pool = require('../config/db');
const createTransactionRecord = require('../utils/createTransactionRecord');
const { auditLog } = require('../utils/auditLog');

let notify = {};
try {
  notify = require('../utils/notify'); // optional
} catch (e) {
  console.warn('notify.js not found → skipping notifications');
}

/**
 * ---------------------------------------------------------
 * LIST PENDING DEPOSITS
 * GET /admin/deposits/pending
 * ---------------------------------------------------------
 */
exports.listPending = async (req, res) => {
  console.log('ADMIN › listPending deposits');

  try {
    const [rows] = await pool.query(`
      SELECT 
        pd.id,
        pd.user_id,
        u.username,
        u.email,
        pd.amount,
        pd.sender_name,
        pd.sender_bank,
        pd.reference,
        pd.status,
        pd.expires_at,
        pd.created_at
      FROM pending_deposits pd
      JOIN users u ON u.id = pd.user_id
      WHERE pd.status = 'pending'
        AND pd.expires_at > NOW()
      ORDER BY pd.created_at ASC
    `);

    return res.json({ status: true, data: rows });
  } catch (err) {
    console.error('listPending error:', err);
    return res
      .status(500)
      .json({ status: false, message: 'Server error' });
  }
};

/**
 * ---------------------------------------------------------
 * MATCH DEPOSIT → CREDIT WALLET
 * POST /admin/deposits/match
 *
 * Body Option A:
 *   { "pending_id": 14 }
 *
 * Body Option B:
 *   { "amount": 5000 }
 * ---------------------------------------------------------
 */
exports.matchDeposit = async (req, res) => {
  const adminId = req.user?.id;
  const { pending_id, amount } = req.body || {};

  console.log('ADMIN › matchDeposit request:', req.body);

  try {
    let dep = null;

    // 1️⃣ MATCH BY ID
    if (pending_id) {
      console.log(' › Direct match mode');

      const [rows] = await pool.query(
        `SELECT * FROM pending_deposits 
         WHERE id = ? AND status = 'pending' AND expires_at > NOW()
         LIMIT 1`,
        [pending_id]
      );

      if (!rows.length) {
        return res
          .status(404)
          .json({ status: false, message: 'Pending deposit not found' });
      }

      dep = rows[0];
    } else {
      // 2️⃣ MATCH BY AMOUNT
      if (!amount) {
        return res
          .status(400)
          .json({ status: false, message: 'amount or pending_id required' });
      }

      console.log(' › Auto-match mode by amount =', amount);

      const [rows] = await pool.query(
        `SELECT * FROM pending_deposits 
         WHERE amount = ? AND status = 'pending' AND expires_at > NOW()
         ORDER BY created_at ASC`,
        [Number(amount)]
      );

      if (!rows.length) {
        return res.status(404).json({
          status: false,
          message: 'No pending deposit found for this amount'
        });
      }

      if (rows.length > 1) {
        // multiple potential matches → let admin pick by id
        return res.status(409).json({
          status: false,
          code: 'MULTIPLE_MATCHES',
          message: 'Multiple pending deposits found. Select by pending_id.',
          data: rows
        });
      }

      dep = rows[0];
    }

    const conn = await pool.getConnection();

    try {
      await conn.beginTransaction();

      // Lock deposit row
      const [locked] = await conn.query(
        `SELECT * FROM pending_deposits 
         WHERE id = ? AND status = 'pending'
         FOR UPDATE`,
        [dep.id]
      );

      if (!locked.length) {
        await conn.rollback();
        conn.release();
        return res.status(409).json({
          status: false,
          message: 'Deposit already processed'
        });
      }

      dep = locked[0];

      // Fetch wallet
      const [walletRows] = await conn.query(
        `SELECT id, balance FROM wallets WHERE user_id = ? LIMIT 1`,
        [dep.user_id]
      );

      if (!walletRows.length) {
        await conn.rollback();
        conn.release();
        return res
          .status(404)
          .json({ status: false, message: 'Wallet not found' });
      }

      const wallet = walletRows[0];
      const amountNum = Number(dep.amount);

      const balanceBefore = Number(wallet.balance);
      const balanceAfter = Number((balanceBefore + amountNum).toFixed(2));

      // Update wallet balance
      await conn.query(
        `UPDATE wallets 
         SET balance = ?, updated_at = NOW() 
         WHERE id = ?`,
        [balanceAfter, wallet.id]
      );

      // Create transaction record
      await createTransactionRecord(conn, {
        user_id: dep.user_id,
        wallet_id: wallet.id,
        type: 'deposit',
        amount: amountNum,
        balance_before: balanceBefore,
        balance_after: balanceAfter,
        reference: dep.reference,
        description: 'Bank transfer (manual match)',
        provider: 'manual',
        admin_id: adminId,
        status: 'completed'
      });

      // Mark deposit as matched
      await conn.query(
        `UPDATE pending_deposits
         SET status = 'matched', updated_at = NOW()
         WHERE id = ?`,
        [dep.id]
      );

      // AUDIT
      await auditLog(
        adminId, // admin performing the match
        dep.user_id,
        'ADMIN_MATCHED_DEPOSIT',
        'pending_deposits',
        dep.id,
        {
          amount: amountNum,
          reference: dep.reference,
          sender_name: dep.sender_name,
          sender_bank: dep.sender_bank
        }
      );

      await conn.commit();
      conn.release();

      // Notifications (best-effort)
      try {
        const [[u]] = await pool.query(
          `SELECT email, username FROM users WHERE id = ? LIMIT 1`,
          [dep.user_id]
        );

        if (notify.sendInApp) {
          notify.sendInApp(
            dep.user_id,
            'Deposit Received',
            `Your deposit of ₦${amountNum} has been credited. Ref: ${dep.reference}`
          );
        }

        if (notify.sendEmail && u?.email) {
          notify.sendEmail(
            u.email,
            'Trebetta Deposit Confirmed',
            `Hello ${u.username},\nYour ₦${amountNum} deposit has been credited.\nRef: ${dep.reference}`
          );
        }
      } catch (e) {
        console.warn('Notification error:', e);
      }

      return res.json({
        status: true,
        message: 'Deposit matched successfully',
        data: {
          deposit_id: dep.id,
          user_id: dep.user_id,
          amount: amountNum,
          reference: dep.reference,
          sender_name: dep.sender_name,
          sender_bank: dep.sender_bank,
          new_balance: balanceAfter
        }
      });
    } catch (innerErr) {
      await conn.rollback();
      conn.release();
      console.error('matchDeposit transaction error:', innerErr);
      return res
        .status(500)
        .json({ status: false, message: 'Server error' });
    }
  } catch (err) {
    console.error('matchDeposit error:', err);
    return res
      .status(500)
      .json({ status: false, message: 'Server error' });
  }
};
/**
 * ---------------------------------------------------------
 * LIST EXPIRED DEPOSITS
 * GET /admin/deposits/expired
 * ---------------------------------------------------------
 */
exports.listExpired = async (req, res) => {
  console.log("ADMIN › listExpired deposits");

  try {
    const [rows] = await pool.query(`
      SELECT 
        pd.id,
        pd.user_id,
        u.username,
        u.email,
        pd.amount,
        pd.reference,
        pd.status,
        pd.expires_at,
        pd.created_at,
        pd.updated_at
      FROM pending_deposits pd
      JOIN users u ON u.id = pd.user_id
      WHERE pd.status = 'expired'
      ORDER BY pd.updated_at DESC
    `);

    return res.json({ status: true, data: rows });

  } catch (err) {
    console.error("listExpired error:", err);
    return res.status(500).json({
      status: false,
      message: "Server error"
    });
  }
};
/**
 * ---------------------------------------------------------
 * EXPIRE OLD PENDING DEPOSITS
 * POST /admin/deposits/expire
 * ---------------------------------------------------------
 */
exports.expireOld = async (req, res) => {
  const adminId = req.user?.id;

  console.log('ADMIN › expireOld pending deposits');

  try {
    const [result] = await pool.query(`
      UPDATE pending_deposits
      SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending' AND expires_at <= NOW()
    `);

    await auditLog(
      adminId, // admin performing action
      null, // no specific user
      'ADMIN_EXPIRED_PENDING_DEPOSITS',
      'pending_deposits',
      null,
      { expired: result.affectedRows }
    );

    return res.json({
      status: true,
      message: `${result.affectedRows} deposits expired`
    });
  } catch (err) {
    console.error('expireOld error:', err);
    return res
      .status(500)
      .json({ status: false, message: 'Server error' });
  }
};

