const request = require('supertest');
const app     = require('../app');
const prisma  = require('../lib/prisma');
const mailer  = require('../lib/mailer');

// mailer.sendInvite hits real SMTP — mock it so invite() can run in CI
// without network access. We assert on how it's called rather than that an
// email is actually delivered.
jest.mock('../lib/mailer');

let adminToken, adminId, orgId;

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
    email: 'members-admin@example.com', password: 'Password123!',
    firstName: 'Admin', lastName: 'One', orgName: 'Members Org',
  });
  adminToken = reg.body.accessToken;
  adminId    = reg.body.user.id;

  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  orgId = me.body.organisations[0].id;
});

afterEach(() => {
  jest.clearAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/members/org/:orgId/invite', () => {
  it('creates an invite and sends an email', async () => {
    mailer.sendInvite.mockResolvedValue();

    const res = await request(app)
      .post(`/api/members/org/${orgId}/invite`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'invitee@example.com', role: 'MEMBER' });

    expect(res.status).toBe(201);
    expect(res.body.inviteId).toBeDefined();
    expect(mailer.sendInvite).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'invitee@example.com', role: 'MEMBER' })
    );
  });

  it('stores only a hash of the invite token, never the raw token (INC-020)', async () => {
    mailer.sendInvite.mockResolvedValue();

    const res = await request(app)
      .post(`/api/members/org/${orgId}/invite`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'hash-check@example.com' });

    const invite = await prisma.invite.findUnique({ where: { id: res.body.inviteId } });
    expect(invite.tokenHash).toBeDefined();
    expect(invite.tokenHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
    // The raw token only ever appears in the URL passed to the mailer, never
    // stored on the invite row itself.
    const [{ inviteUrl }] = mailer.sendInvite.mock.calls[0];
    expect(invite.tokenHash).not.toEqual(inviteUrl);
  });

  it('rejects inviting someone who is already a member', async () => {
    mailer.sendInvite.mockResolvedValue();

    const res = await request(app)
      .post(`/api/members/org/${orgId}/invite`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'members-admin@example.com' }); // the admin themself
    expect(res.status).toBe(409);
  });

  it('rolls back the invite row if email delivery fails', async () => {
    mailer.sendInvite.mockRejectedValue(new Error('SMTP down'));

    const res = await request(app)
      .post(`/api/members/org/${orgId}/invite`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: 'rollback-check@example.com' });

    expect(res.status).toBe(502);
    const invite = await prisma.invite.findFirst({ where: { email: 'rollback-check@example.com' } });
    expect(invite).toBeNull();
  });

  it('requires admin role', async () => {
    // Seed a plain MEMBER via a direct invite/accept so we have a non-admin
    // token to test with.
    const { hashToken } = require('../lib/tokenHash');
    const rawToken = 'member-role-check-token';
    await prisma.invite.create({
      data: {
        email: 'plain-member@example.com',
        role: 'MEMBER',
        tokenHash: hashToken(rawToken),
        organisationId: orgId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await request(app).post('/api/members/accept-invite').send({
      token: rawToken, password: 'Password123!', firstName: 'Plain', lastName: 'Member',
    });
    const login = await request(app).post('/api/auth/login').send({
      email: 'plain-member@example.com', password: 'Password123!',
    });

    const res = await request(app)
      .post(`/api/members/org/${orgId}/invite`)
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .send({ email: 'someone-else@example.com' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/members/accept-invite', () => {
  it('accepts a valid invite and creates a membership', async () => {
    const { hashToken } = require('../lib/tokenHash');
    const rawToken = 'accept-flow-token';
    await prisma.invite.create({
      data: {
        email: 'accepted@example.com',
        role: 'MEMBER',
        tokenHash: hashToken(rawToken),
        organisationId: orgId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const res = await request(app).post('/api/members/accept-invite').send({
      token: rawToken, password: 'Password123!', firstName: 'New', lastName: 'Member',
    });
    expect(res.status).toBe(200);

    const user = await prisma.user.findUnique({ where: { email: 'accepted@example.com' } });
    const member = await prisma.member.findUnique({
      where: { userId_organisationId: { userId: user.id, organisationId: orgId } },
    });
    expect(member).not.toBeNull();
    expect(member.role).toBe('MEMBER');
  });

  it('rejects an unknown token', async () => {
    const res = await request(app).post('/api/members/accept-invite').send({
      token: 'not-a-real-token', password: 'Password123!', firstName: 'X', lastName: 'Y',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an already-accepted invite (no double-accept)', async () => {
    const { hashToken } = require('../lib/tokenHash');
    const rawToken = 'double-accept-token';
    await prisma.invite.create({
      data: {
        email: 'double-accept@example.com',
        role: 'MEMBER',
        tokenHash: hashToken(rawToken),
        organisationId: orgId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const first = await request(app).post('/api/members/accept-invite').send({
      token: rawToken, password: 'Password123!', firstName: 'First', lastName: 'Try',
    });
    expect(first.status).toBe(200);

    const second = await request(app).post('/api/members/accept-invite').send({
      token: rawToken, password: 'Password123!', firstName: 'Second', lastName: 'Try',
    });
    expect(second.status).toBe(400);
  });

  it('rejects an expired invite', async () => {
    const { hashToken } = require('../lib/tokenHash');
    const rawToken = 'expired-token';
    await prisma.invite.create({
      data: {
        email: 'expired@example.com',
        role: 'MEMBER',
        tokenHash: hashToken(rawToken),
        organisationId: orgId,
        expiresAt: new Date(Date.now() - 1000), // already expired
      },
    });

    const res = await request(app).post('/api/members/accept-invite').send({
      token: rawToken, password: 'Password123!', firstName: 'Late', lastName: 'Comer',
    });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/members/org/:orgId/:memberId', () => {
  let memberToRemoveId;

  beforeAll(async () => {
    const { hashToken } = require('../lib/tokenHash');
    const rawToken = 'removable-member-token';
    await prisma.invite.create({
      data: {
        email: 'removable@example.com',
        role: 'MEMBER',
        tokenHash: hashToken(rawToken),
        organisationId: orgId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await request(app).post('/api/members/accept-invite').send({
      token: rawToken, password: 'Password123!', firstName: 'Removable', lastName: 'Member',
    });
    const user = await prisma.user.findUnique({ where: { email: 'removable@example.com' } });
    const member = await prisma.member.findUnique({
      where: { userId_organisationId: { userId: user.id, organisationId: orgId } },
    });
    memberToRemoveId = member.id;
  });

  it('removes another member', async () => {
    const res = await request(app)
      .delete(`/api/members/org/${orgId}/${memberToRemoveId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
  });

  it('blocks removing yourself', async () => {
    const me = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);
    const selfMember = await prisma.member.findUnique({
      where: { userId_organisationId: { userId: adminId, organisationId: orgId } },
    });
    const res = await request(app)
      .delete(`/api/members/org/${orgId}/${selfMember.id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it('404s for a member id that does not exist', async () => {
    const res = await request(app)
      .delete(`/api/members/org/${orgId}/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/members/org/:orgId/:memberId/role', () => {
  let targetMemberId, targetUserId;

  beforeAll(async () => {
    const { hashToken } = require('../lib/tokenHash');
    const rawToken = 'role-change-token';
    await prisma.invite.create({
      data: {
        email: 'role-change@example.com',
        role: 'MEMBER',
        tokenHash: hashToken(rawToken),
        organisationId: orgId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await request(app).post('/api/members/accept-invite').send({
      token: rawToken, password: 'Password123!', firstName: 'Role', lastName: 'Change',
    });
    targetUserId = (await prisma.user.findUnique({ where: { email: 'role-change@example.com' } })).id;
    targetMemberId = (await prisma.member.findUnique({
      where: { userId_organisationId: { userId: targetUserId, organisationId: orgId } },
    })).id;
  });

  it('promotes a member to admin', async () => {
    const res = await request(app)
      .patch(`/api/members/org/${orgId}/${targetMemberId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'ADMIN' });
    expect(res.status).toBe(200);
    expect(res.body.member.role).toBe('ADMIN');
  });

  it('blocks changing your own role', async () => {
    const selfMember = await prisma.member.findUnique({
      where: { userId_organisationId: { userId: adminId, organisationId: orgId } },
    });
    const res = await request(app)
      .patch(`/api/members/org/${orgId}/${selfMember.id}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'MEMBER' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid role value with 422', async () => {
    const res = await request(app)
      .patch(`/api/members/org/${orgId}/${targetMemberId}/role`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'SUPERUSER' });
    expect(res.status).toBe(422);
  });
});
