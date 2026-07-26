const request = require('supertest');
const app     = require('../app');
const prisma  = require('../lib/prisma');

let adminToken, adminId, orgId;
let memberToken;

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
    email: 'org-admin@example.com', password: 'Password123!',
    firstName: 'Org', lastName: 'Admin', orgName: 'Org Under Test',
  });
  adminToken = reg.body.accessToken;
  adminId    = reg.body.user.id;

  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  orgId = me.body.organisations[0].id;

  const { hashToken } = require('../lib/tokenHash');
  const rawToken = 'org-test-member-token';
  await prisma.invite.create({
    data: {
      email: 'org-member@example.com',
      role: 'MEMBER',
      tokenHash: hashToken(rawToken),
      organisationId: orgId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await request(app).post('/api/members/accept-invite').send({
    token: rawToken, password: 'Password123!', firstName: 'Org', lastName: 'Member',
  });
  const login = await request(app).post('/api/auth/login').send({
    email: 'org-member@example.com', password: 'Password123!',
  });
  memberToken = login.body.accessToken;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/organisations/:orgId', () => {
  it('returns the organisation with its members', async () => {
    const res = await request(app)
      .get(`/api/organisations/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.organisation.id).toBe(orgId);
    expect(res.body.organisation.members.length).toBeGreaterThanOrEqual(2);
  });

  it('a non-member cannot access the org (IDOR)', async () => {
    const outsider = await request(app).post('/api/auth/register').send({
      email: 'outsider@example.com', password: 'Password123!',
      firstName: 'Out', lastName: 'Sider', orgName: 'Outsider Org',
    });
    const res = await request(app)
      .get(`/api/organisations/${orgId}`)
      .set('Authorization', `Bearer ${outsider.body.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/organisations/:orgId', () => {
  it('updates the org name', async () => {
    const res = await request(app)
      .patch(`/api/organisations/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Renamed Org' });
    expect(res.status).toBe(200);
    expect(res.body.organisation.name).toBe('Renamed Org');
  });

  it('requires admin role', async () => {
    const res = await request(app)
      .patch(`/api/organisations/${orgId}`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ name: 'Should not work' });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/organisations/:orgId/audit-log', () => {
  it('returns paginated audit log entries for admins', async () => {
    const res = await request(app)
      .get(`/api/organisations/${orgId}/audit-log`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
    expect(res.body.total).toBeGreaterThan(0);
  });

  it('blocks non-admins from reading the audit log', async () => {
    const res = await request(app)
      .get(`/api/organisations/${orgId}/audit-log`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/organisations/:orgId/audit-log/verify', () => {
  it('reports the hash chain as valid', async () => {
    const res = await request(app)
      .get(`/api/organisations/${orgId}/audit-log/verify`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });
});

describe('DELETE /api/organisations/:orgId (INC-023 soft delete)', () => {
  let deleteOrgId, deleteAdminToken, deleteTaskId, deleteMemberId, deleteInviteId;

  beforeAll(async () => {
    const reg = await request(app).post('/api/auth/register').send({
      email: 'delete-admin@example.com', password: 'Password123!',
      firstName: 'Delete', lastName: 'Admin', orgName: 'Org To Delete',
    });
    deleteAdminToken = reg.body.accessToken;
    const me = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${deleteAdminToken}`);
    deleteOrgId = me.body.organisations[0].id;

    const task = await request(app)
      .post(`/api/tasks/org/${deleteOrgId}`)
      .set('Authorization', `Bearer ${deleteAdminToken}`)
      .send({ title: 'Task in org to be deleted' });
    deleteTaskId = task.body.task.id;

    const { hashToken } = require('../lib/tokenHash');
    const invite = await prisma.invite.create({
      data: {
        email: 'pending-invite@example.com',
        role: 'MEMBER',
        tokenHash: hashToken('pending-invite-token'),
        organisationId: deleteOrgId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    deleteInviteId = invite.id;
  });

  it('soft-deletes the organisation and cascades to members, tasks, and invites', async () => {
    const res = await request(app)
      .delete(`/api/organisations/${deleteOrgId}`)
      .set('Authorization', `Bearer ${deleteAdminToken}`);
    expect(res.status).toBe(200);

    const org = await prisma.organisation.findUnique({ where: { id: deleteOrgId } });
    expect(org.deletedAt).not.toBeNull();

    const task = await prisma.task.findUnique({ where: { id: deleteTaskId } });
    expect(task.deletedAt).not.toBeNull();

    const invite = await prisma.invite.findUnique({ where: { id: deleteInviteId } });
    expect(invite.deletedAt).not.toBeNull();

    const members = await prisma.member.findMany({ where: { organisationId: deleteOrgId } });
    expect(members.every(m => m.deletedAt !== null)).toBe(true);
  });

  it('blocks further access to a soft-deleted org via requireOrgMember', async () => {
    const res = await request(app)
      .get(`/api/organisations/${deleteOrgId}`)
      .set('Authorization', `Bearer ${deleteAdminToken}`);
    expect(res.status).toBe(403);
  });

  it('an invite belonging to a soft-deleted org can no longer be accepted', async () => {
    const res = await request(app).post('/api/members/accept-invite').send({
      token: 'pending-invite-token', password: 'Password123!', firstName: 'Late', lastName: 'Invite',
    });
    expect(res.status).toBe(400);
  });
});
