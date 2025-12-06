// controllers/adminTransactionController.js
const pool = require('../config/db');
const { auditLog } = require('./_adminHelpers');
const createTransactionRecord  = require('../utils/createTransactionRecord');
const notify = require("../utils/notify");
const { Parser } = require('json2csv'); // lightweight CSV writer (install json2csv)

const dvaService = require('../services/dva'); // must implement verifyTransaction(reference, gateway)

const ALLOWED_TYPES = ['deposit','withdrawal','transfer','admin_credit','admin_debit','bet_stake','bet_payout'];

async function listTransactions(req, res) {
  try {
    const { user_id, type, status, start, end, page = 1, limit = 50 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const clauses = [];
    const params = [];

    if (user_id) { clauses.push('t.user_id = ?'); params.push(user_id); }
    if (type) { clauses.push('t.type = ?'); params.push(type); }
    if (status) { clauses.push('t.status = ?'); params.push(status); }
    if (start) { clauses.push('t.created_at >= ?'); params.push(start); }
    if (end) { clauses.push('t.created_at <= ?'); params.push(end); }

    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
    const sql = `SELECT t.*, u.username, u.email FROM transactions t LEFT JOIN users u ON u.id = t.user_id ${where} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`;
    const [rows] = await pool.query(sql, [...params, Number(limit), Number(offset)]);
    const [countRows] = await pool.query(`SELECT COUNT(*) as total FROM transactions t ${where}`, params);

    return res.json({ data: rows, meta: { total: countRows[0].total, page: Number(page), limit: Number(limit) } });
  } catch (err) {
    console.error('listTransactions err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
}

async function getTransaction(req, res) {
  try {
    const id = Number(req.params.id);
    const [[tx]] = await pool.query('SELECT t.*, u.username, u.email FROM transactions t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ? LIMIT 1', [id]);
    if (!tx) return res.status(404).json({ message: 'Transaction not found' });
    return res.json({ transaction: tx });
  } catch (err) {
    console.error('getTransaction err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
}

// POST /api/admin/transactions/verify/:reference
// This will call external provider via services/dva.verifyTransaction(reference, gateway)
async function verifyTransaction(req, res) {
  try {
    const { reference } = req.params;
    if (!reference) return res.status(400).json({ message: 'reference required' });

    const [[txRow]] = await pool.query('SELECT * FROM transactions WHERE reference = ? LIMIT 1', [reference]);
    if (!txRow) return res.status(404).json({ message: 'Transaction not found' });

    // if already completed/failed, return status
    if (txRow.status === 'completed') return res.json({ message: 'Already completed', transaction: txRow });
    if (txRow.status === 'failed') return res.json({ message: 'Transaction already failed', transaction: txRow });

    // Detect gateway from tx.gateway or try to infer
    const gateway = txRow.gateway || req.body.gateway || 'paystack';

    // Call external provider to verify
    const verifyRes = await dvaService.verifyTransaction(reference, gateway);
    // expect verifyRes = { success: boolean, amount: number, providerReference, raw }
    if (!verifyRes || !verifyRes.success) {
      // mark failed
      await pool.query('UPDATE transactions SET status = ?, updated_at = NOW() WHERE id = ?', ['failed', txRow.id]);
      await auditLog(pool, req.user.id, 'VERIFY_TRANSACTION_FAILED', 'transaction', txRow.id, { reference, gateway, provider: verifyRes });
      return res.status(400).json({ message: 'Verification failed or not confirmed by provider', provider: verifyRes });
    }

    // If provider confirms, atomic wallet credit/debit depending on type
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // lock wallet
      const [walletRows] = await conn.query('SELECT * FROM wallets WHERE id = ? FOR UPDATE', [txRow.wallet_id]);
      if (!walletRows.length) { await conn.rollback(); return res.status(500).json({ message: 'Wallet missing' }); }
      const wallet = walletRows[0];
      const before = Number(wallet.balance || 0);
      let after = before;

      if (txRow.type === 'deposit' || txRow.type === 'admin_credit' || txRow.type === 'bet_payout') {
        after = (before + Number(verifyRes.amount || txRow.amount)).toFixed(2);
      } else if (txRow.type === 'withdrawal' || txRow.type === 'admin_debit') {
        // For withdrawal, ensure funds were reserved earlier; if not, deduct now
        after = (before - Number(verifyRes.amount || txRow.amount)).toFixed(2);
        if (Number(after) < 0) {
          await conn.rollback();
          return res.status(400).json({ message: 'Insufficient wallet balance to confirm withdrawal' });
        }
      } else {
        // other types: just mark completed
        after = (before + 0).toFixed(2);
      }

      // update wallet and transaction
      await conn.query('UPDATE wallets SET balance = ?, updated_at = NOW() WHERE id = ?', [after, wallet.id]);
      await conn.query('UPDATE transactions SET status = ?, balance_before = ?, balance_after = ?, updated_at = NOW() WHERE id = ?', ['completed', before, after, txRow.id]);

      // audit + notify + create transaction record if required (some records already exist)
      await auditLog(conn, req.user.id, 'VERIFY_TRANSACTION', 'transaction', txRow.id, { reference, gateway, provider: verifyRes });

      // notify user
      try { notify(txRow.user_id, `Transaction ${reference} completed`, { type: 'transaction', reference, amount: verifyRes.amount || txRow.amount }); } catch(e){}
      try { notify(txRow.user_id, 'Transaction completed', `Transaction ${reference} has been completed.`); } catch(e){}

      await conn.commit();
      return res.json({ message: 'Transaction verified and completed', transaction_id: txRow.id, reference });
    } catch (err) {
      await conn.rollback();
      console.error('verifyTransaction process err', err);
      return res.status(500).json({ message: 'Server error', error: err.message });
    } finally {
      conn.release();
    }
  } catch (err) {
    console.error('verifyTransaction err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
}

// POST /api/admin/transactions/reverse/:id   body { reason }
async function reverseTransaction(req, res) {
  const adminId = req.user?.id;
  const txId = Number(req.params.id);
  const { reason } = req.body || {};
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();
    const [txRows] = await conn.query('SELECT * FROM transactions WHERE id = ? FOR UPDATE', [txId]);
    if (!txRows.length) { await conn.rollback(); return res.status(404).json({ message: 'Transaction not found' }); }
    const tx = txRows[0];
    if (tx.is_reversal) { await conn.rollback(); return res.status(400).json({ message: 'Cannot reverse a reversal' }); }

    // lock wallet
    const [walletRows] = await conn.query('SELECT * FROM wallets WHERE id = ? FOR UPDATE', [tx.wallet_id]);
    if (!walletRows.length) { await conn.rollback(); return res.status(404).json({ message: 'Wallet not found' }); }
    const wallet = walletRows[0];

    let reverseAmount = Number(tx.amount || 0);
    let newBalance = Number(wallet.balance || 0);

    if (['deposit','admin_credit','bet_payout'].includes(tx.type)) {
      // remove funds
      if (newBalance < reverseAmount) { await conn.rollback(); return res.status(400).json({ message: 'Insufficient wallet funds to reverse' }); }
      newBalance = (newBalance - reverseAmount).toFixed(2);
    } else {
      // for debit/withdrawal: refund
      newBalance = (newBalance + reverseAmount).toFixed(2);
    }

    // update wallet
    await conn.query('UPDATE wallets SET balance = ?, updated_at = NOW() WHERE id = ?', [newBalance, wallet.id]);

    // mark original tx reversed and create reversal tx
    await conn.query('UPDATE transactions SET status = ?, is_reversal = 1, reversed_by = ?, reversal_reason = ?, updated_at = NOW() WHERE id = ?', ['reversed', adminId, reason || null, txId]);

    const reversalRef = `REV-${tx.reference || txId}-${Date.now()}`;
    await createTransactionRecord(conn, {
      user_id: tx.user_id,
      wallet_id: tx.wallet_id,
      type: `reversal_${tx.type}`,
      amount: reverseAmount,
      balance_before: tx.balance_after,
      balance_after: Number(newBalance),
      reference: reversalRef,
      description: `Reversal of tx ${txId}`,
      reason: reason || 'Admin reversal',
      metadata: { original_tx: txId },
      admin_id: adminId,
      status: 'completed',
      is_reversal: 1
    });

    await auditLog(conn, adminId, 'REVERSE_TRANSACTION', 'transaction', txId, { reason, reversal_reference: reversalRef });
    await conn.commit();

    try { notify(tx.user_id, 'Transaction reversed', `Transaction ${tx.reference} has been reversed. Reason: ${reason || 'Admin action'}`, { type: 'transaction_reversal', reference: reversalRef }); } catch(e){}
    try { notify(tx.user_id, 'Transaction reversed', `Transaction ${tx.reference} has been reversed. Reference: ${reversalRef}`); } catch(e){}

    return res.json({ message: 'Transaction reversed', reversal_reference: reversalRef, new_balance: Number(newBalance) });
  } catch (err) {
    await conn.rollback();
    console.error('reverseTransaction err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
}

async function exportTransactionsCSV(req, res) {
  // same filters as listTransactions
  const { user_id, type, status, start, end } = req.query;
  const clauses = [];
  const params = [];
  if (user_id) { clauses.push('user_id = ?'); params.push(user_id); }
  if (type) { clauses.push('type = ?'); params.push(type); }
  if (status) { clauses.push('status = ?'); params.push(status); }
  if (start) { clauses.push('created_at >= ?'); params.push(start); }
  if (end) { clauses.push('created_at <= ?'); params.push(end); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  try {
    const [rows] = await pool.query(`SELECT * FROM transactions ${where} ORDER BY created_at DESC`, params);
    const fields = ['id','user_id','wallet_id','type','amount','balance_before','balance_after','reference','recipient_id','description','reason','status','admin_id','created_at'];
    const parser = new Parser({ fields });
    const csv = parser.parse(rows);
    res.header('Content-Type', 'text/csv');
    res.attachment(`transactions_${Date.now()}.csv`);
    return res.send(csv);
  } catch (err) {
    console.error('exportTransactionsCSV err', err);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
}


module.exports = { listTransactions, getTransaction, verifyTransaction, reverseTransaction, exportTransactionsCSV };
