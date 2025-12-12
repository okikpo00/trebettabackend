// controllers/bankAlertController.js
const pool = require('../config/db');
const { auditLog } = require('../utils/auditLog');
const createTransactionRecord = require('../utils/createTransactionRecord');

/* -------------------------------------------------------
   1. PARSE STERLING BANK SMS
--------------------------------------------------------*/
function parseSterlingSms(message = "") {
  if (!message) return null;

  const amtMatch = message.match(/NGN([\d,]+\.\d{2})/i);
  if (!amtMatch) return null;
  const amount = Number(amtMatch[1].replace(/,/g, ""));

  const senderMatch = message.match(/from\s+(.+?)\s+into/i);
  const sender_name = senderMatch ? senderMatch[1].trim() : null;

  const last4Match = message.match(/\*+(\d{3,4})/);
  const account_last4 = last4Match ? last4Match[1] : null;

  const timeMatch = message.match(/at\s([\d\-: ]{16,})/i);
  const txn_time = timeMatch ? new Date(timeMatch[1]) : null;

  return { amount, sender_name, account_last4, txn_time };
}

/* -------------------------------------------------------
   2. MATCH BY AMOUNT + SENDER NAME
--------------------------------------------------------*/
async function matchByAmountAndSender(amount, senderName) {
  if (!senderName) return [];

  const [rows] = await pool.query(
    `SELECT * FROM pending_deposits
     WHERE amount = ?
       AND status = 'pending'
       AND expires_at > NOW()
     ORDER BY created_at ASC`,
    [amount]
  );

  if (!rows.length) return [];

  const normSender = senderName.toLowerCase().replace(/\s+/g, "");

  return rows.filter(dep => {
    if (!dep.sender_name) return false;
    const normDep = dep.sender_name.toLowerCase().replace(/\s+/g, "");
    return normDep === normSender;
  });
}

/* -------------------------------------------------------
   3. MATCH BY AMOUNT ONLY
--------------------------------------------------------*/
async function matchByAmount(amount) {
  const [rows] = await pool.query(
    `SELECT * FROM pending_deposits
     WHERE amount = ?
       AND status = 'pending'
       AND expires_at > NOW()
     ORDER BY created_at ASC`,
    [amount]
  );
  return rows;
}

/* -------------------------------------------------------
   4. CREDIT USER WALLET (ATOMIC)
--------------------------------------------------------*/
async function creditWalletFromPending(conn, dep, alertId) {
  const [walletRows] = await conn.query(
    `SELECT id, balance FROM wallets WHERE user_id = ? LIMIT 1`,
    [dep.user_id]
  );
  if (!walletRows.length) throw new Error("Wallet not found");

  const wallet = walletRows[0];
  const amountNum = Number(dep.amount);

  const before = Number(wallet.balance);
  const after = Number((before + amountNum).toFixed(2));

  await conn.query(
    `UPDATE wallets SET balance = ?, updated_at = NOW() WHERE id = ?`,
    [after, wallet.id]
  );

  await createTransactionRecord(conn, {
    user_id: dep.user_id,
    wallet_id: wallet.id,
    type: "deposit",
    amount: amountNum,
    balance_before: before,
    balance_after: after,
    reference: dep.reference,
    description: "Bank transfer (auto-match from SMS)",
    provider: "manual",
    admin_id: null,
    status: "completed"
  });

  await conn.query(
    `UPDATE pending_deposits
     SET status = 'matched', updated_at = NOW()
     WHERE id = ?`,
    [dep.id]
  );

  await conn.query(
    `UPDATE bank_alerts
     SET status = 'matched', matched_pending_id = ?, updated_at = NOW()
     WHERE id = ?`,
    [dep.id, alertId]
  );

  await auditLog(
    null,
    dep.user_id,
    "AUTO_MATCHED_DEPOSIT",
    "pending_deposits",
    dep.id,
    { amount: amountNum, reference: dep.reference, alert_id: alertId }
  );

  return after;
}

/* -------------------------------------------------------
   5. RECEIVE BANK SMS → AUTO MATCH ENGINE
--------------------------------------------------------*/
exports.receiveBankSms = async (req, res) => {
  try {
    const secret = req.headers["x-sms-secret"];
    if (!secret || secret !== process.env.SMS_ALERT_SECRET) {
      return res.status(401).json({ status: false, message: "Unauthorized" });
    }

    const { message } = req.body || {};
    if (!message) {
      return res.status(400).json({ status: false, message: "SMS message is required" });
    }

    const parsed = parseSterlingSms(message);
    if (!parsed) {
      return res.status(400).json({ status: false, message: "Unable to parse SMS" });
    }

    const [ins] = await pool.query(
      `INSERT INTO bank_alerts
       (raw_message, amount, sender_name, account_last4, txn_time, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'unmatched', NOW(), NOW())`,
      [
        message,
        parsed.amount,
        parsed.sender_name,
        parsed.account_last4,
        parsed.txn_time
      ]
    );
    const alertId = ins.insertId;

    /* -----------------------------------------
       LEVEL 1: AMOUNT + SENDER NAME MATCH
    ------------------------------------------*/
    let matches = await matchByAmountAndSender(parsed.amount, parsed.sender_name);

    if (matches.length === 1) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();

        const newBal = await creditWalletFromPending(conn, matches[0], alertId);

        await conn.commit();
        conn.release();

        return res.json({
          status: true,
          message: "Auto-matched successfully (amount + sender)",
          data: { alertId, new_balance: newBal, user_id: matches[0].user_id }
        });
      } catch (err) {
        await conn.rollback();
        conn.release();
        throw err;
      }
    }

    if (matches.length > 1) {
      await pool.query(
        `UPDATE bank_alerts SET status = 'multiple', updated_at = NOW() WHERE id = ?`,
        [alertId]
      );
      return res.json({
        status: false,
        message: "Multiple potential matches. Admin must choose.",
        data: { alertId, candidates: matches }
      });
    }

    /* -----------------------------------------
       LEVEL 2: AMOUNT ONLY MATCH
    ------------------------------------------*/
    const amountOnly = await matchByAmount(parsed.amount);

    if (amountOnly.length === 1) {
      return res.json({
        status: true,
        message: "Amount-only match found. Admin confirmation required.",
        data: { alertId, pending: amountOnly[0] }
      });
    }

    if (amountOnly.length > 1) {
      await pool.query(
        `UPDATE bank_alerts SET status = 'multiple', updated_at = NOW() WHERE id = ?`,
        [alertId]
      );
      return res.json({
        status: false,
        message: "Multiple same-amount deposits. Admin must decide.",
        data: { alertId, candidates: amountOnly }
      });
    }

    /* -----------------------------------------
       LEVEL 3: NO MATCH
    ------------------------------------------*/
    await pool.query(
      `UPDATE bank_alerts SET status = 'unmatched', updated_at = NOW() WHERE id = ?`,
      [alertId]
    );

    return res.json({
      status: true,
      message: "Alert stored but no matching deposit found.",
      data: { alertId, parsed }
    });

  } catch (err) {
    console.error("SMS Alert Error:", err);
    return res.status(500).json({ status: false, message: "Server error" });
  }
};
