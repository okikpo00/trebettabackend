// src/utils/cache.js
const redis = require('../config/redis');

module.exports = {
  async get(key) {
    try {
      const v = await redis.get(key);
      return v ? JSON.parse(v) : null;
    } catch (e) {
      console.warn('cache.get error', e.message);
      return null;
    }
  },

  async set(key, value, ttlSeconds = 60) {
    try {
      await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (e) {
      console.warn('cache.set error', e.message);
    }
  },

  async del(key) {
    try {
      await redis.del(key);
    } catch (e) {
      console.warn('cache.del error', e.message);
    }
  },

  async incr(key) {
    return redis.incr(key);
  }
};
