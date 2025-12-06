// utils/createTransactionRecord.js
const pool = require('../config/db');

async function createTransactionRecord(connOrPool, data) {
  const useConn = connOrPool && connOrPool.execute ? connOrPool : pool;
  const {
    user_id, wallet_id, type, amount, balance_before, balance_after,
    reference, recipient_id=null, description=null, reason=null, metadata=null, admin_id=null, status='completed'
  } = data;

  const sql = `INSERT INTO transactions
    (user_id, wallet_id, type, amount, balance_before, balance_after, reference, recipient_id, description, reason, metadata, admin_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`;

  const params = [
    user_id, wallet_id, type, amount, balance_before, balance_after,
    reference, recipient_id, description, reason, metadata ? JSON.stringify(metadata) : null, admin_id, status
  ];

  if (useConn.execute) {
    const [r] = await useConn.execute(sql, params);
    return r.insertId;
  } else {
    const [r] = await useConn.query(sql, params);
    return r.insertId;
  }
}

module.exports = createTransactionRecord;
