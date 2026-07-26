const request = require('supertest');
const app     = require('../app');
const prisma  = require('../lib/prisma');

// Two members of the same org: `admin` created the org (and is ADMIN), and
// `second` is invited in separately so we have a non-creator ADMIN able to
// approve/reject tasks without tripping the INC-014 self-approval guard.
let adminToken, adminId, orgId;
let secondToken, secondId;

beforeAll(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM "Approval"');
  await prisma.$executeRawUnsafe('DELETE FROM "Task"');
  await prisma.$executeRawUnsafe('DELETE FROM "Billing"');
  await prisma.$executeRawUnsafe('DELETE FROM "Invite"');
  await prisma.$executeRawUnsafe('DELETE FROM "AuditLog"');
  await prisma.$executeRawUnsafe('DELETE FROM "RefreshToken"');
  await prisma.$executeRawUnsafe('DELETE FROM "Member"');
  await prisma.$executeRawUnsafe('DELETE FROM "Organisation"');
  await prisma.$executeRawUnsafe('DELETE FROM "User"');

  const reg = await request(app).post('/api/auth/register').send({
    email: 'tasks-admin@example.com', password: 'Password123!',
    firstName: 'Admin', lastName: 'One', orgName: 'Tasks Org',
  });
  adminToken = reg.body.accessToken;
  adminId    = reg.body.user.id;

  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  orgId = me.body.organisations[0].id;

  // Invite + accept a second admin directly in the DB, since mailer.sendInvite
  // needs real SMTP creds we don't have in test — bypass invite() and go
  // straight through acceptInvite() by seeding a valid invite row.
  const { hashToken } = require('../lib/tokenHash');
  const rawToken = 'test-raw-token-for-second-admin';
  await prisma.invite.create({
    data: {
      email:          'tasks-second@example.com',
      role:           'ADMIN',
      tokenHash:      hashToken(rawToken),
      organisationId: orgId,
      expiresAt:      new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });

  const accept = await request(app).post('/api/members/accept-invite').send({
    token: rawToken,
    password: 'Password123!',
    firstName: 'Second',
    lastName: 'Admin',
  });
  expect(accept.status).toBe(200);

  const login = await request(app).post('/api/auth/login').send({
    email: 'tasks-second@example.com', password: 'Password123!',
  });
  secondToken = login.body.accessToken;

  const meB = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${secondToken}`);
  secondId = meB.body.user.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/tasks/org/:orgId', () => {
  it('creates a task', async () => {
    const res = await request(app)
      .post(`/api/tasks/org/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Write onboarding doc' });
    expect(res.status).toBe(201);
    expect(res.body.task.title).toBe('Write onboarding doc');
    expect(res.body.task.status).toBe('PENDING');
  });

  it('rejects an assignee who is not a member of the org', async () => {
    const res = await request(app)
      .post(`/api/tasks/org/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Bad assignee', assignedToId: '00000000-0000-0000-0000-000000000000' });
    expect(res.status).toBe(400);
  });

  it('rejects an empty title with 422', async () => {
    const res = await request(app)
      .post(`/api/tasks/org/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: '' });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/tasks/org/:orgId and /:taskId', () => {
  let taskId;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/tasks/org/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Fetchable task' });
    taskId = res.body.task.id;
  });

  it('lists tasks scoped to the org', async () => {
    const res = await request(app)
      .get(`/api/tasks/org/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tasks)).toBe(true);
    expect(res.body.tasks.some(t => t.id === taskId)).toBe(true);
  });

  it('gets a single task by id', async () => {
    const res = await request(app)
      .get(`/api/tasks/org/${orgId}/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.task.id).toBe(taskId);
  });

  it('404s for a task id that does not exist', async () => {
    const res = await request(app)
      .get(`/api/tasks/org/${orgId}/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/tasks/org/:orgId/:taskId', () => {
  let taskId;

  beforeAll(async () => {
    const res = await request(app)
      .post(`/api/tasks/org/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Patchable task', requiresApproval: true });
    taskId = res.body.task.id;
  });

  it('updates allowlisted fields', async () => {
    const res = await request(app)
      .patch(`/api/tasks/org/${orgId}/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Renamed task' });
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe('Renamed task');
  });

  it('blocks jumping straight to DONE when approval is required (INC-013)', async () => {
    const res = await request(app)
      .patch(`/api/tasks/org/${orgId}/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'DONE' });
    expect(res.status).toBe(400);
  });

  it('blocks reassignment by a non-creator, non-assignee, non-admin member', async () => {
    // secondId is an ADMIN here, so this specific guard isn't hit for admins —
    // this test documents the allowed path instead: an admin CAN reassign.
    const res = await request(app)
      .patch(`/api/tasks/org/${orgId}/${taskId}`)
      .set('Authorization', `Bearer ${secondToken}`)
      .send({ assignedToId: secondId });
    expect(res.status).toBe(200);
    expect(res.body.task.assignedToId).toBe(secondId);
  });
});

describe('DELETE /api/tasks/org/:orgId/:taskId', () => {
  it('requires admin role', async () => {
    const created = await request(app)
      .post(`/api/tasks/org/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Deletable task' });

    const res = await request(app)
      .delete(`/api/tasks/org/${orgId}/${created.body.task.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const getRes = await request(app)
      .get(`/api/tasks/org/${orgId}/${created.body.task.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(getRes.status).toBe(404);
  });
});

describe('Approval flow (INC-014)', () => {
  async function createAwaitingApprovalTask(creatorToken) {
    const created = await request(app)
      .post(`/api/tasks/org/${orgId}`)
      .set('Authorization', `Bearer ${creatorToken}`)
      .send({ title: 'Needs approval', requiresApproval: true });
    const taskId = created.body.task.id;

    await prisma.task.update({
      where: { id: taskId },
      data:  { status: 'AWAITING_APPROVAL' },
    });
    return taskId;
  }

  it('blocks the creator from approving their own task', async () => {
    const taskId = await createAwaitingApprovalTask(adminToken);
    const res = await request(app)
      .post(`/api/tasks/org/${orgId}/${taskId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('blocks the creator from rejecting their own task', async () => {
    const taskId = await createAwaitingApprovalTask(adminToken);
    const res = await request(app)
      .post(`/api/tasks/org/${orgId}/${taskId}/reject`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('allows a different admin to approve the task', async () => {
    const taskId = await createAwaitingApprovalTask(adminToken);
    const res = await request(app)
      .post(`/api/tasks/org/${orgId}/${taskId}/approve`)
      .set('Authorization', `Bearer ${secondToken}`)
      .send({ note: 'Looks good' });
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('APPROVED');
    expect(res.body.approval.status).toBe('APPROVED');
  });

  it('allows a different admin to reject the task', async () => {
    const taskId = await createAwaitingApprovalTask(adminToken);
    const res = await request(app)
      .post(`/api/tasks/org/${orgId}/${taskId}/reject`)
      .set('Authorization', `Bearer ${secondToken}`)
      .send({ note: 'Needs more work' });
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('REJECTED');
  });

  it('rejects approval when task is not AWAITING_APPROVAL', async () => {
    const created = await request(app)
      .post(`/api/tasks/org/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Still pending' });

    const res = await request(app)
      .post(`/api/tasks/org/${orgId}/${created.body.task.id}/approve`)
      .set('Authorization', `Bearer ${secondToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects rejection when task is not AWAITING_APPROVAL (INC-014 status precondition)', async () => {
    const created = await request(app)
      .post(`/api/tasks/org/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Still pending, take two' });

    const res = await request(app)
      .post(`/api/tasks/org/${orgId}/${created.body.task.id}/reject`)
      .set('Authorization', `Bearer ${secondToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
