// controllers/depositAdminController.js
const pool = require('../config/db');
const genRef = require('../utils/generateReference');
const createTransactionRecord  = require('../utils/createTransactionRecord');
const { auditLog } = require('../utils/auditLog');

/**
 * ---------------------------------------------------------
 * ADMIN MANUAL DEPOSIT (PRODUCTION READY)
 * POST /admin/deposits/manual
 * ---------------------------------------------------------
 */


async function manualDeposit(req, res) {
  const adminId = req.user?.id;
  let { user_id, amount, reason } = req.body || {};

  // --- VALIDATE INPUTS ---
  const amt = Number(amount);
  if (!user_id || isNaN(amt) || amt <= 0) {
    return res.status(400).json({ status: false, message: "Invalid amount or user_id" });
  }

  const description = String(reason || "Manual deposit by admin");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [wallets] = await conn.query(
      "SELECT * FROM wallets WHERE user_id = ? LIMIT 1",
      [user_id]
    );
    if (!wallets.length) {
      await conn.rollback();
      return res.status(404).json({ status: false, message: "Wallet not found" });
    }

    const wallet = wallets[0];
    const balanceBefore = Number(wallet.balance || 0);
    const balanceAfter = Number((balanceBefore + amt).toFixed(2));

    // --- UPDATE WALLET ---
    await conn.query(
      "UPDATE wallets SET balance = ?, updated_at = NOW() WHERE id = ?",
      [balanceAfter, wallet.id]
    );

    const reference = genRef("ADMIN_DEP");

    // --- CREATE TRANSACTION ---
    await createTransactionRecord(conn, {
      user_id: Number(user_id),
      wallet_id: wallet.id,
      type: "admin_credit",
      amount: amt,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      reference,
      description,
      provider: "Manual",
      admin_id: adminId,
      status: "completed"
    });

    // --- AUDIT LOG ---
    await auditLog(
      conn,
      adminId,
      "ADMIN_MANUAL_DEPOSIT",
      "wallets",
      wallet.id,
      { user_id, amount: amt, balance_after: balanceAfter }
    );

    await conn.commit();

    return res.json({
      status: true,
      message: "Manual deposit successful",
      new_balance: balanceAfter
    });

  } catch (err) {
    await conn.rollback();
    console.error("manualDeposit error:", err);
    return res.status(500).json({ status: false, message: "Server error" });
  } finally {
    conn.release();
  }
}

/**
 * ---------------------------------------------------------
 * ADMIN LIST ALL DEPOSITS
 * ---------------------------------------------------------
 * GET /admin/deposits
 *
 * Supports:
 * ?status=
 * ?user_id=
 * ?reference=
 * ?provider=
 * ?from=YYYY-MM-DD
 * ?to=YYYY-MM-DD
 * ?page=1
 * ?limit=50
 */
async function listDeposits(req, res) {
  try {
    const {
      status,
      user_id,
      reference,
      provider,
      from,
      to,
      page = 1,
      limit = 50
    } = req.query;

    const offset = (page - 1) * limit;

    const clauses = [
      "t.type IN ('deposit', 'admin_credit')"
    ];
    const params = [];

    if (status) { clauses.push("t.status = ?"); params.push(status); }
    if (user_id) { clauses.push("t.user_id = ?"); params.push(user_id); }
    if (reference) { clauses.push("t.reference LIKE ?"); params.push(`%${reference}%`); }
    if (provider) { clauses.push("t.provider = ?"); params.push(provider); }

    if (from && to) {
      clauses.push("DATE(t.created_at) BETWEEN ? AND ?");
      params.push(from, to);
    } else if (from) {
      clauses.push("DATE(t.created_at) >= ?");
      params.push(from);
    } else if (to) {
      clauses.push("DATE(t.created_at) <= ?");
      params.push(to);
    }

    const where = clauses.length ? "WHERE " + clauses.join(" AND ") : "";

    // MAIN SELECT
    const sql = `
      SELECT
        t.id,
        t.user_id,
        u.username,
        t.amount,
        t.type,
        t.provider,
        t.status,
        t.reference,
        t.description,
        t.created_at
      FROM transactions t
      LEFT JOIN users u ON u.id = t.user_id
      ${where}
      ORDER BY t.created_at DESC
      LIMIT ? OFFSET ?
    `;

    // COUNT QUERY
    const countSql = `
      SELECT COUNT(*) AS total
      FROM transactions t
      LEFT JOIN users u ON u.id = t.user_id
      ${where}
    `;

    const [rows] = await pool.query(sql, [...params, Number(limit), offset]);
    const [countRows] = await pool.query(countSql, params);
    const total = countRows[0]?.total || 0;

    return res.json({
      status: true,
      data: rows,
      total,
      pagination: { page: Number(page), limit: Number(limit) }
    });

  } catch (err) {
    console.error('listDeposits err', err);
    return res.status(500).json({ status: false, message: 'Server error' });
  }
}

module.exports = {
  manualDeposit,
  listDeposits
};
