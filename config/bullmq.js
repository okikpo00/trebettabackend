const { Queue, Worker, QueueScheduler } = require('bullmq');
const redisConnection = require('./redis');

const connection = { connection: redisConnection.options ? redisConnection.options : { host: process.env.REDIS_HOST || '127.0.0.1', port: process.env.REDIS_PORT || 6379 } };


const SETTLEMENT_QUEUE_NAME = process.env.SETTLEMENT_QUEUE_NAME || 'pool_settlement';
const queue = new Queue(SETTLEMENT_QUEUE_NAME, connection);

// Worker is created by worker file to process jobs.

module.exports = { queue,  SETTLEMENT_QUEUE_NAME, connection };
