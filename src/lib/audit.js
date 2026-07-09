const crypto = require('crypto');
const prisma = require('./prisma');
const logger = require('./logger');

/**
 * Append-only audit log with SHA-256 hash chain.
 * Each entry hashes the previous entry's hash + current action + timestamp
 * making tampering detectable — changing one entry invalidates all entries after it.
 */

async function getLastHash(organisationId) {
  const last = await prisma.auditLog.findFirst({
    where: { organisationId },
    orderBy: { createdAt: 'desc' },
    select: { hash: true },
  });
  return last?.hash || null;
}

function computeHash(previousHash, action, timestamp) {
  return crypto
    .createHash('sha256')
    .update(`${previousHash || ''}:${action}:${timestamp}`)
    .digest('hex');
}

async function log({ action, resource, resourceId, actor, organisationId, metadata, ipAddress }) {
  try {
    const timestamp = new Date();
    const previousHash = await getLastHash(organisationId);
    const hash = computeHash(previousHash, action, timestamp.toISOString());

    await prisma.auditLog.create({
      data: {
        action,
        resource,
        resourceId,
        actorId:       actor?.id   || null,
        actorEmail:    actor?.email || null,
        metadata:      metadata    || {},
        ipAddress:     ipAddress   || null,
        hash,
        previousHash,
        organisationId: organisationId || null,
        createdAt:     timestamp,
      },
    });
  } catch (err) {
    // Audit log failure must never crash the request
    logger.error('Audit log write failed', { err: err.message, action });
  }
}

async function verifyChain(organisationId) {
  const logs = await prisma.auditLog.findMany({
    where: { organisationId },
    orderBy: { createdAt: 'asc' },
  });

  let valid = true;
  for (let i = 1; i < logs.length; i++) {
    const expected = computeHash(
      logs[i].previousHash,
      logs[i].action,
      logs[i].createdAt.toISOString()
    );
    if (expected !== logs[i].hash) {
      logger.error('Audit chain integrity violation', {
        entryId: logs[i].id,
        index: i,
      });
      valid = false;
    }
  }
  return valid;
}

module.exports = { log, verifyChain };
