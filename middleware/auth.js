// middlewares/requireAuth.js
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

module.exports = async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ message: 'No token provided' });

    const secret = process.env.USER_JWT_SECRET || process.env.JWT_SECRET;
    const payload = jwt.verify(token, secret);
    if (!payload || !payload.id) return res.status(401).json({ message: 'Invalid token' });

    // Fetch user from DB
    const [users] = await pool.query(
      'SELECT id, username, first_name, last_name, email, phone, role, status, kyc_status, transaction_pin_hash FROM users WHERE id = ? LIMIT 1',
      [payload.id]
    );
    if (!users.length) return res.status(401).json({ message: 'User not found' });

    const user = users[0];

    // Fetch wallet
    let [wallets] = await pool.query('SELECT id, balance FROM wallets WHERE user_id = ? LIMIT 1', [user.id]);

    if (!wallets.length) {
      // Create wallet if not exists
      const [resWallet] = await pool.query(
        'INSERT INTO wallets (user_id, balance, reserved_balance, currency, status) VALUES (?, 0, 0, ?, "active")',
        [user.id, 'NGN']
      );
      wallets = [{ id: resWallet.insertId, balance: 0 }];
    }

    const wallet = wallets[0];

    // Attach user info + wallet
    req.user = {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      phone: user.phone,
      role: user.role,
      status: user.status,
      kyc_status: user.kyc_status,
      wallet_id: wallet.id,
      wallet_balance: wallet.balance,
      transaction_pin_hash: user.transaction_pin_hash,
     has_pin: !!user.transaction_pin_hash 
    };

    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    return res.status(401).json({ message: 'Unauthorized', error: err.message });
  }
};
