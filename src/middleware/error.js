const logger = require('../lib/logger');

function notFound(req, res) {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
}

function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  // Never leak stack traces or internal details in production
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'An unexpected error occurred'
    : err.message || 'Internal server error';

  logger.error('Request error', {
    status,
    message: err.message,
    path:    req.path,
    method:  req.method,
    stack:   err.stack,
  });

  res.status(status).json({ error: message });
}

module.exports = { notFound, errorHandler };
