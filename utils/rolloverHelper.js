// utils/rolloverHelper.js
const pool = require('../config/db');
const logger = require('./logger');

async function addToRollover(connOrPool, amount) {
  const connection = connOrPool || pool;
  const amt = Number(amount || 0);
  if (!amt || amt <= 0) return { success: false, message: 'invalid amount' };

  const sql = `
    INSERT INTO rollover_pool_balance (id, amount, updated_at)
    VALUES (1, ?, NOW())
    ON DUPLICATE KEY UPDATE amount = amount + VALUES(amount), updated_at = NOW()
  `;

  try {
    await connection.query(sql, [amt]);
    logger.info(`Added ₦${amt.toFixed(2)} to rollover balance`);
    return { success: true, added: amt };
  } catch (err) {
    logger.error('addToRollover err', err);
    throw err;
  }
}

async function getRolloverBalance(connOrPool) {
  const connection = connOrPool || pool;
  try {
    const [rows] = await connection.query(
      'SELECT amount FROM rollover_pool_balance WHERE id = 1 LIMIT 1'
    );
    if (!rows.length) return { amount: 0 };
    return { amount: Number(rows[0].amount || 0) };
  } catch (err) {
    logger.error('getRolloverBalance err', err);
    throw err;
  }
}

async function consumeFromRollover(connOrPool, amount) {
  const connection = connOrPool || pool;
  const amt = Number(amount || 0);
  if (!amt || amt <= 0) return { success: false, consumed: 0 };

  const conn = connection.getConnection ? await connection.getConnection() : null;

  if (conn) {
    try {
      await conn.beginTransaction();

      const [[row]] = await conn.query(
        'SELECT amount FROM rollover_pool_balance WHERE id = 1 FOR UPDATE'
      );

      const available = Number(row?.amount || 0);
      const toConsume = Math.min(available, amt);

      if (toConsume > 0) {
        await conn.query(
          'UPDATE rollover_pool_balance SET amount = amount - ? WHERE id = 1',
          [toConsume]
        );
      }

      await conn.commit();
      return { success: true, consumed: toConsume };
    } catch (err) {
      await conn.rollback();
      logger.error('consumeFromRollover err', err);
      throw err;
    } finally {
      conn.release();
    }
  }

  // fallback (no transaction)
  try {
    const { amount: available } = await getRolloverBalance(connection);
    const toConsume = Math.min(available, amt);

    if (toConsume > 0) {
      await connection.query(
        'UPDATE rollover_pool_balance SET amount = amount - ? WHERE id = 1',
        [toConsume]
      );
    }

    return { success: true, consumed: toConsume };
  } catch (err) {
    logger.error('consumeFromRollover err', err);
    throw err;
  }
}

module.exports = { addToRollover, getRolloverBalance, consumeFromRollover };
