// backend/controllers/transactionController.js
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');

/*
  IMPORTANT:
  This controller expects the transactions table to have these columns:
  (id, wallet_id, user_id, type, amount, status, reference, recipient_id, description, meta, created_at)
  See SQL snippet below if you need to create/adjust the table.
*/

async function findWalletByUser(conn, userId) {
  const [rows] = await conn.query('SELECT id, balance FROM wallets WHERE user_id = ? LIMIT 1', [userId]);
  return rows[0] || null;
}

exports.deposit = async (req, res) => {
  const amount = Number(req.body.amount);
  const userId = req.user.id;

  if (!amount || amount <= 0) {
    return res.status(400).json({ message: 'Invalid deposit amount' });
  }

  const reference = uuidv4();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // get wallet
    const wallet = await findWalletByUser(conn, userId);
    if (!wallet) {
      await conn.rollback();
      return res.status(404).json({ message: 'Wallet not found' });
    }

    // insert transaction
    const [insertResult] = await conn.query(
      `INSERT INTO transactions (wallet_id, user_id, type, amount, status, reference, description) 
       VALUES (?, ?, 'deposit', ?, 'completed', ?, ?)`,
      [wallet.id, userId, amount, reference, 'deposit']
    );

    // update wallet balance
    await conn.query(
      `UPDATE wallets SET balance = balance + ?, updated_at = NOW() WHERE id = ?`,
      [amount, wallet.id]
    );

    await conn.commit();
    res.status(201).json({
      message: 'Deposit successful',
      transactionId: insertResult.insertId,
      reference,
    });
  } catch (err) {
    await conn.rollback();
    console.error('Deposit error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
};

exports.withdraw = async (req, res) => {
  const amount = Number(req.body.amount);
  const userId = req.user.id;

  if (!amount || amount <= 0) {
    return res.status(400).json({ message: 'Invalid withdrawal amount' });
  }

  const reference = uuidv4();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const wallet = await findWalletByUser(conn, userId);
    if (!wallet) {
      await conn.rollback();
      return res.status(404).json({ message: 'Wallet not found' });
    }

    if (Number(wallet.balance) < amount) {
      await conn.rollback();
      return res.status(400).json({ message: 'Insufficient funds' });
    }

    // Create a pending withdrawal (do NOT deduct balance yet)
    const [insertResult] = await conn.query(
      `INSERT INTO transactions (wallet_id, user_id, type, amount, status, reference, description)
       VALUES (?, ?, 'withdrawal', ?, 'pending', ?, ?)`,
      [wallet.id, userId, amount, reference, 'withdrawal request']
    );

    await conn.commit();
    res.status(201).json({
      message: 'Withdrawal request submitted (pending approval)',
      transactionId: insertResult.insertId,
      reference,
      status: 'pending',
    });
  } catch (err) {
    await conn.rollback();
    console.error('Withdraw error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
};

exports.transfer = async (req, res) => {
  const senderId = req.user.id;
  const { recipientUsername, amount } = req.body;
  const amt = Number(amount);

  if (!recipientUsername || !amt || amt <= 0) {
    return res.status(400).json({ message: 'recipientUsername and positive amount required' });
  }

  const reference = uuidv4();
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // find recipient user and wallet
    const [rRows] = await conn.query('SELECT id, username FROM users WHERE username_lower = ? LIMIT 1', [
      String(recipientUsername).toLowerCase(),
    ]);
    const recipient = rRows[0];
    if (!recipient) {
      await conn.rollback();
      return res.status(404).json({ message: 'Recipient not found' });
    }

    // lock wallets by selecting FOR UPDATE (in same transaction)
    const [sRows] = await conn.query('SELECT id, balance FROM wallets WHERE user_id = ? FOR UPDATE', [senderId]);
    const senderWallet = sRows[0];
    if (!senderWallet) {
      await conn.rollback();
      return res.status(404).json({ message: 'Sender wallet not found' });
    }

    const [rcRows] = await conn.query('SELECT id, balance FROM wallets WHERE user_id = ? FOR UPDATE', [recipient.id]);
    const recipientWallet = rcRows[0];
    if (!recipientWallet) {
      await conn.rollback();
      return res.status(404).json({ message: 'Recipient wallet not found' });
    }

    if (Number(senderWallet.balance) < amt) {
      await conn.rollback();
      return res.status(400).json({ message: 'Insufficient funds' });
    }

    // Deduct from sender
    await conn.query('UPDATE wallets SET balance = balance - ?, updated_at = NOW() WHERE id = ?', [amt, senderWallet.id]);

    // Credit recipient
    await conn.query('UPDATE wallets SET balance = balance + ?, updated_at = NOW() WHERE id = ?', [amt, recipientWallet.id]);

    // Insert transaction records for sender and recipient (same reference)
    const [senderTx] = await conn.query(
      `INSERT INTO transactions (wallet_id, user_id, type, amount, status, reference, recipient_id, description)
       VALUES (?, ?, 'transfer', ?, 'completed', ?, ?, ?)`,
      [senderWallet.id, senderId, amt, reference, recipient.id, `transfer to ${recipient.username}`]
    );

    await conn.query(
      `INSERT INTO transactions (wallet_id, user_id, type, amount, status, reference, recipient_id, description)
       VALUES (?, ?, 'transfer', ?, 'completed', ?, ?, ?)`,
      [recipientWallet.id, recipient.id, amt, reference, senderId, `transfer from user ${senderId}`]
    );

    await conn.commit();
    res.status(201).json({ message: 'Transfer successful', transactionId: senderTx.insertId, reference });
  } catch (err) {
    await conn.rollback();
    console.error('Transfer error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    conn.release();
  }
};

exports.getTransactions = async (req, res) => {
  const userId = req.user.id;
  try {
    const [rows] = await pool.query(
      `SELECT t.*, u.username as actor_username
       FROM transactions t
       LEFT JOIN users u ON t.user_id = u.id
       WHERE t.user_id = ?
       ORDER BY t.created_at DESC`,
      [userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Get transactions error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
};
