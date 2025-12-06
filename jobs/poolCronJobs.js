// src/jobs/poolCronJobs.js
const pool = require('../config/db');
const { queue } = require('../config/bullmq');

async function autoLockAndQueue() {
  try {
    const [rows] = await pool.query('SELECT id FROM pools WHERE status = "open" AND closing_date IS NOT NULL AND closing_date <= NOW()');
    for (const r of rows) {
      // lock pool
      await pool.query('UPDATE pools SET status = "locked" WHERE id = ?', [r.id]);
      // optionally enqueue settlement job later after admin sets winner or automated selection
      console.log('Auto-locked pool', r.id);
    }
  } catch (e) {
    console.error('cron autoLock error', e.message);
  }
}

function startCron() {
  // run every minute
  setInterval(autoLockAndQueue, 60 * 1000);
  console.log('Pool cron jobs started');
}

module.exports = { startCron };
