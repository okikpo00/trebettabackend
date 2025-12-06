// utils/redis.js
const IORedis = require('ioredis');

const REDIS_HOST = process.env.REDIS_HOST;
const REDIS_PORT = process.env.REDIS_PORT;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'trebetta:';

// If REDIS_URL is provided, prefer it (e.g. redis://:password@host:port)
let redis;

if (process.env.REDIS_URL) {
  redis = new IORedis(process.env.REDIS_URL, {
    keyPrefix: KEY_PREFIX,
    maxRetriesPerRequest: null,
  });
} else {
  redis = new IORedis({
    host: REDIS_HOST || '127.0.0.1',
    port: Number(REDIS_PORT || 6379),
    password: REDIS_PASSWORD || undefined,
    keyPrefix: KEY_PREFIX,
    maxRetriesPerRequest: null,
  });
}

redis.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

redis.on('error', (err) => {
  console.error('❌ Redis error:', err.message);
});

module.exports = redis;

