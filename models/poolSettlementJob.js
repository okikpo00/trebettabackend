// src/models/PoolSettlementJobs.js
const pool = require('../config/db');

async function createJob(poolId, jobId) {
  const [res] = await pool.query('INSERT INTO pool_settlement_jobs (pool_id, job_id, status, attempts, created_at) VALUES (?, ?, ?, 0, NOW())', [poolId, jobId, 'queued']);
  return res.insertId;
}

async function updateStatus(id, status, attempts = null, last_error = null) {
  const fields = ['status = ?', 'updated_at = NOW()'];
  const params = [status];
  if (attempts !== null) { fields.push('attempts = ?'); params.push(attempts); }
  if (last_error !== null) { fields.push('last_error = ?'); params.push(last_error); }
  params.push(id);
  await pool.query(`UPDATE pool_settlement_jobs SET ${fields.join(', ')} WHERE id = ?`, params);
}

module.exports = { createJob, updateStatus };
