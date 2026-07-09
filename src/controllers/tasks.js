const prisma = require('../lib/prisma');
const audit  = require('../lib/audit');

async function list(req, res, next) {
  try {
    const tasks = await prisma.task.findMany({
      where: { organisationId: req.organisation.id }, // always scoped to org
      include: {
        createdBy:  { select: { id: true, firstName: true, lastName: true, email: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
        approvals:  { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ tasks });
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  try {
    // Allowlist — explicitly pick only the fields we accept
    const { title, description, requiresApproval, assignedToId } = req.body;

    // Verify assignee belongs to same org if provided
    if (assignedToId) {
      const assigneeMember = await prisma.member.findUnique({
        where: {
          userId_organisationId: {
            userId:         assignedToId,
            organisationId: req.organisation.id,
          }
        }
      });
      if (!assigneeMember) {
        return res.status(400).json({ error: 'Assignee is not a member of this organisation' });
      }
    }

    const task = await prisma.task.create({
      data: {
        title,
        description,
        requiresApproval: requiresApproval || false,
        organisationId:   req.organisation.id,
        createdById:      req.user.id,
        assignedToId:     assignedToId || null,
        status:           'PENDING',
      },
    });

    await audit.log({
      action:         'task.create',
      resource:       'task',
      resourceId:     task.id,
      actor:          req.user,
      organisationId: req.organisation.id,
      metadata:       { title },
      ipAddress:      req.ip,
    });

    return res.status(201).json({ task });
  } catch (err) { next(err); }
}

async function get(req, res, next) {
  try {
    const task = await prisma.task.findFirst({
      where: {
        id:             req.params.taskId,
        organisationId: req.organisation.id, // IDOR defence
      },
      include: {
        createdBy:  { select: { id: true, firstName: true, lastName: true, email: true } },
        assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
        approvals:  { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
      },
    });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    return res.json({ task });
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const existing = await prisma.task.findFirst({
      where: { id: req.params.taskId, organisationId: req.organisation.id }
    });
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    // Strict allowlist — only these fields, nothing else from req.body
    const allowed = ['title', 'description', 'status', 'assignedToId'];
    const data = {};
    for (const field of allowed) {
      if (req.body[field] !== undefined) data[field] = req.body[field];
    }

    const task = await prisma.task.update({
      where: { id: existing.id },
      data,
    });

    await audit.log({
      action:         'task.update',
      resource:       'task',
      resourceId:     task.id,
      actor:          req.user,
      organisationId: req.organisation.id,
      metadata:       { changes: Object.keys(data) },
      ipAddress:      req.ip,
    });

    return res.json({ task });
  } catch (err) { next(err); }
}

async function remove(req, res, next) {
  try {
    const existing = await prisma.task.findFirst({
      where: { id: req.params.taskId, organisationId: req.organisation.id }
    });
    if (!existing) return res.status(404).json({ error: 'Task not found' });

    await prisma.task.delete({ where: { id: existing.id } });

    await audit.log({
      action:         'task.delete',
      resource:       'task',
      resourceId:     existing.id,
      actor:          req.user,
      organisationId: req.organisation.id,
      ipAddress:      req.ip,
    });

    return res.json({ message: 'Task deleted' });
  } catch (err) { next(err); }
}

async function approve(req, res, next) {
  try {
    const task = await prisma.task.findFirst({
      where: { id: req.params.taskId, organisationId: req.organisation.id }
    });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.status !== 'AWAITING_APPROVAL') {
      return res.status(400).json({ error: 'Task is not awaiting approval' });
    }

    const [approval, updated] = await prisma.$transaction([
      prisma.approval.create({
        data: { taskId: task.id, userId: req.user.id, status: 'APPROVED', note: req.body.note }
      }),
      prisma.task.update({ where: { id: task.id }, data: { status: 'APPROVED' } })
    ]);

    await audit.log({
      action:         'task.approve',
      resource:       'task',
      resourceId:     task.id,
      actor:          req.user,
      organisationId: req.organisation.id,
      ipAddress:      req.ip,
    });

    return res.json({ task: updated, approval });
  } catch (err) { next(err); }
}

async function reject(req, res, next) {
  try {
    const task = await prisma.task.findFirst({
      where: { id: req.params.taskId, organisationId: req.organisation.id }
    });
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const [approval, updated] = await prisma.$transaction([
      prisma.approval.create({
        data: { taskId: task.id, userId: req.user.id, status: 'REJECTED', note: req.body.note }
      }),
      prisma.task.update({ where: { id: task.id }, data: { status: 'REJECTED' } })
    ]);

    await audit.log({
      action:         'task.reject',
      resource:       'task',
      resourceId:     task.id,
      actor:          req.user,
      organisationId: req.organisation.id,
      ipAddress:      req.ip,
    });

    return res.json({ task: updated, approval });
  } catch (err) { next(err); }
}

module.exports = { list, create, get, update, remove, approve, reject };
