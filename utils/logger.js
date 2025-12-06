// src/utils/logger.js
const util = require('util');

function _formatArgs(args) {
  return args.map(a =>
    typeof a === 'object' ? util.inspect(a, { depth: 4, colors: false }) : a
  );
}

function log(...args) {
  console.log(new Date().toISOString(), ..._formatArgs(args));
}
function info(...args) {
  log('[INFO]', ...args);
}
function warn(...args) {
  log('[WARN]', ...args);
}
function error(...args) {
  try {
    console.error(new Date().toISOString(), '[ERROR]', ..._formatArgs(args));
  } catch (e) {
    // fallback - never throw from logger
    console.error(new Date().toISOString(), '[ERROR]', args);
  }
}

module.exports = { log, info, warn, error };
