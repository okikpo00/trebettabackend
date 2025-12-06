// src/workers/poolSettlementWorker.js
const { Worker } = require('bullmq');
const { queue, connection } = require('../config/bullmq'); // your config should export connection object
const payoutService = require('../services/payoutService');
const logger = require('../utils/logger');

const QUEUE_NAME = process.env.SETTLEMENT_QUEUE_NAME || 'pool_settlement_queue'; // ensure matches config/bullmq

// Worker: processes settlement jobs
const worker = new Worker(
  QUEUE_NAME,
  async job => {
    const { poolId, winningOptionId, initiatedBy, jobId } = job.data;
    logger.info(`Worker processing job ${jobId} for pool ${poolId}`);
    // call settlePool (the function handles DB transaction)
    return payoutService.settlePool(poolId, winningOptionId, initiatedBy, jobId);
  },
  { connection: connection.connection || connection } // adapt to your bullmq config export shape
);

// listen for events
worker.on('completed', (job) => {
  logger.info(`Settlement job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  logger.error(`Settlement job ${job?.id} failed:`, err?.message || err);
});

worker.on('error', (err) => {
  logger.error('Worker error', err);
});

module.exports = worker;
