// src/services/walletService.js
const pool = require('../config/db');
const { v4: uuidv4 } = require('uuid');

/**
 * Get wallet by user_id
 */
async function getWalletByUserId(userId) {
  console.log('walletService.getWalletByUserId › userId:', userId);
  const [rows] = await pool.query('SELECT * FROM wallets WHERE user_id = ? LIMIT 1', [userId]);
  return rows[0] || null;
}

/**
 * Debit user wallet
 * 
 * NOTE:
 * - Backward compatible: old calls using (conn, userId, amount, reason) still work.
 * - New calls MAY pass an optional options object:
 *   debitUserWallet(conn, userId, amount, reason, {
 *     type: 'withdrawal' | 'bet_stake' | 'admin_debit' | ...,
 *     gateway: 'internal' | 'flutterwave' | 'paystack' | ...,
 *     reference: 'CUSTOM-REF-123',
 *     description: 'Human readable description'
 *   })
 */
async function debitUserWallet(conn, userId, amount, reason = 'debit', options = {}) {
  const connProvided = !!conn;
  const c = connProvided ? conn : await pool.getConnection();

  // Safe defaults for backward compatibility
  const type = options.type || 'withdrawal'; // ORIGINAL BEHAVIOUR
  const gateway = options.gateway || 'internal';
  const description = options.description || reason;
  const customRef = options.reference;

  try {
    if (!connProvided) await c.beginTransaction();
    console.log(
      'walletService.debitUserWallet › userId:',
      userId,
      'amount:',
      amount,
      'reason:',
      reason,
      'type:',
      type,
      'gateway:',
      gateway
    );

    // get wallet for update
    const [wRows] = await c.query('SELECT * FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
    if (!wRows.length) throw new Error('wallet_not_found');
    const wallet = wRows[0];

    const before = Number(wallet.balance || 0);
    const amt = Number(amount);

    if (Number.isNaN(amt) || amt <= 0) {
      throw new Error('invalid_amount');
    }

    if (before < amt) throw new Error('insufficient_balance');

    const after = Number((before - amt).toFixed(2)); // ensure numeric

    await c.query('UPDATE wallets SET balance = ? WHERE id = ?', [after, wallet.id]);

    const reference =
      customRef || `WAL-${Date.now()}-${uuidv4().slice(0, 8)}`;

    const [tx] = await c.query(
      `INSERT INTO transactions (
         wallet_id, user_id, type, amount, gateway,
         balance_before, balance_after, status, reference, description, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, NOW())`,
      [wallet.id, userId, type, amt, gateway, before, after, reference, description]
    );

    if (!connProvided) await c.commit();

    return {
      walletId: wallet.id,
      transactionId: tx.insertId,
      balance_before: before,
      balance_after: after,
      reference
    };
  } catch (e) {
    console.error('walletService.debitUserWallet error:', e.message || e);
    if (!connProvided) await c.rollback();
    throw e;
  } finally {
    if (!connProvided) c.release();
  }
}

/**
 * Credit user wallet
 * 
 * NOTE:
 * - Backward compatible: old calls using (conn, userId, amount, reason) still work.
 * - New calls MAY pass an optional options object:
 *   creditUserWallet(conn, userId, amount, reason, {
 *     type: 'admin_credit' | 'deposit' | 'bet_payout' | ...,
 *     gateway: 'internal' | 'flutterwave' | 'paystack' | ...,
 *     reference: 'CUSTOM-REF-123',
 *     description: 'Human readable description'
 *   })
 */
async function creditUserWallet(conn, userId, amount, reason = 'credit', options = {}) {
  const connProvided = !!conn;
  const c = connProvided ? conn : await pool.getConnection();

  // Safe defaults for backward compatibility
  const type = options.type || 'admin_credit'; // ORIGINAL BEHAVIOUR
  const gateway = options.gateway || 'internal';
  const description = options.description || reason;
  const customRef = options.reference;

  try {
    if (!connProvided) await c.beginTransaction();
    console.log(
      'walletService.creditUserWallet › userId:',
      userId,
      'amount:',
      amount,
      'reason:',
      reason,
      'type:',
      type,
      'gateway:',
      gateway
    );

    const [wRows] = await c.query('SELECT * FROM wallets WHERE user_id = ? FOR UPDATE', [userId]);
    if (!wRows.length) throw new Error('wallet_not_found');
    const wallet = wRows[0];

    const before = Number(wallet.balance || 0);
    const amt = Number(amount);

    if (Number.isNaN(amt) || amt <= 0) {
      throw new Error('invalid_amount');
    }

    const after = Number((before + amt).toFixed(2)); // ensure numeric

    await c.query('UPDATE wallets SET balance = ? WHERE id = ?', [after, wallet.id]);

    const reference =
      customRef || `WAL-${Date.now()}-${uuidv4().slice(0, 8)}`;

    const [tx] = await c.query(
      `INSERT INTO transactions (
         wallet_id, user_id, type, amount, gateway,
         balance_before, balance_after, status, reference, description, created_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, NOW())`,
      [wallet.id, userId, type, amt, gateway, before, after, reference, description]
    );

    if (!connProvided) await c.commit();

    return {
      walletId: wallet.id,
      transactionId: tx.insertId,
      balance_before: before,
      balance_after: after,
      reference
    };
  } catch (e) {
    console.error('walletService.creditUserWallet error:', e.message || e);
    if (!connProvided) await c.rollback();
    throw e;
  } finally {
    if (!connProvided) c.release();
  }
}

module.exports = {
  getWalletByUserId,
  debitUserWallet,
  creditUserWallet
};
