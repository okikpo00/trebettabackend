// src/utils/responseHandler.js

/**
 * @description Standardized API response utility
 * Keeps responses consistent across all controllers.
 */

exports.respond = (res, success = false, message = '', status = 200, data = null) => {
  try {
    return res.status(status).json({
      status: success,
      message,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('ResponseHandler Error:', err);
    return res.status(500).json({
      status: false,
      message: 'Internal Server Error (Response Handler)',
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * @description Handles unexpected errors gracefully
 */
exports.handleError = (res, error, message = 'Server error', status = 500) => {
  console.error('ErrorHandler:', error);
  return res.status(status).json({
    status: false,
    message,
    error: error?.message || message,
    timestamp: new Date().toISOString(),
  });
};