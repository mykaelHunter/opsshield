const prisma = require('../lib/prisma');
const audit  = require('../lib/audit');

async function get(req, res, next) {
  try {
    const org = await prisma.organisation.findUnique({
      where: { id: req.organisation.id },
      include: {
        members: {
          include: {
            user: { select: { id: true, firstName: true, lastName: true, email: true } }
          }
        }
      }
    });
    return res.json({ organisation: org });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    // Strict allowlist — name only. Plan changes go through billing only.
    const { name } = req.body;
    const org = await prisma.organisation.update({
      where: { id: req.organisation.id },
      data:  { name },
    });

    await audit.log({
      action:         'organisation.update',
      resource:       'organisation',
      resourceId:     org.id,
      actor:          req.user,
      organisationId: org.id,
      metadata:       { name },
      ipAddress:      req.ip,
    });

    return res.json({ organisation: org });
  } catch (err) { next(err); }
}

async function auditLog(req, res, next) {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 50;

    const logs = await prisma.auditLog.findMany({
      where:   { organisationId: req.organisation.id },
      orderBy: { createdAt: 'desc' },
      skip:    (page - 1) * limit,
      take:    limit,
    });

    const total = await prisma.auditLog.count({
      where: { organisationId: req.organisation.id }
    });

    return res.json({ logs, total, page, limit });
  } catch (err) { next(err); }
}

async function verifyAuditChain(req, res, next) {
  try {
    const valid = await audit.verifyChain(req.organisation.id);
    return res.json({ valid, organisationId: req.organisation.id });
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const orgId = req.organisation.id;
    const now = new Date();

    // Soft delete, not a real DELETE — the org row and all its children
    // stay in place (audit trail, billing history, etc. must survive this),
    // they're just marked deletedAt and requireOrgMember treats that as
    // "doesn't exist" for every subsequent request.
    await prisma.$transaction([
      prisma.organisation.update({ where: { id: orgId }, data: { deletedAt: now } }),
      prisma.task.updateMany({ where: { organisationId: orgId }, data: { deletedAt: now } }),
      prisma.invite.updateMany({ where: { organisationId: orgId }, data: { deletedAt: now } }),
      prisma.member.updateMany({ where: { organisationId: orgId }, data: { deletedAt: now } }),
    ]);

    await audit.log({
      action:         'organisation.delete',
      resource:       'organisation',
      resourceId:     orgId,
      actor:          req.user,
      organisationId: orgId,
      ipAddress:      req.ip,
    });

    return res.json({ message: 'Organisation deleted' });
  } catch (err) { next(err); }
}

module.exports = { get, update, auditLog, verifyAuditChain, remove };
