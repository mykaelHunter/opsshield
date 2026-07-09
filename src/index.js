require('dotenv').config();
const app = require('./app');
const logger = require('./lib/logger');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(`OpsShield running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully');
  process.exit(0);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason });
  process.exit(1);
});
