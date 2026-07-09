const { PrismaClient } = require('@prisma/client');
const logger = require('./logger');

const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'query' },
    { emit: 'event', level: 'error' },
  ],
});

if (process.env.NODE_ENV === 'development') {
  prisma.$on('query', (e) => {
    logger.debug('Prisma query', { query: e.query, duration: e.duration });
  });
}

prisma.$on('error', (e) => {
  logger.error('Prisma error', { message: e.message });
});

module.exports = prisma;
