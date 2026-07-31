const request = require('supertest');
const app     = require('../app');
const prisma  = require('../lib/prisma');
const featureFlags = require('../lib/featureFlags');

let adminToken, orgId, secondOrgId;

beforeAll(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM "OrganisationFeatureFlag"');
  await prisma.$executeRawUnsafe('DELETE FROM "FeatureFlag"');
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
    email: 'flag-admin@example.com', password: 'Password123!',
    firstName: 'Flag', lastName: 'Admin', orgName: 'Flag Org One',
  });
  adminToken = reg.body.accessToken;

  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  orgId = me.body.organisations[0].id;

  const org2 = await prisma.organisation.create({
    data: { name: 'Flag Org Two', slug: 'flag-org-two' },
  });
  secondOrgId = org2.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(() => {
  featureFlags._clearCacheForTests();
});

describe('isEnabled() resolution order', () => {
  beforeAll(async () => {
    await prisma.featureFlag.create({
      data: { key: 'beta-dashboard', description: 'New dashboard UI', enabled: false },
    });
    await prisma.featureFlag.create({
      data: { key: 'always-on-thing', description: 'On by default', enabled: true },
    });
  });

  it('falls back to the global default when no org override exists', async () => {
    expect(await featureFlags.isEnabled('beta-dashboard', orgId)).toBe(false);
    expect(await featureFlags.isEnabled('always-on-thing', orgId)).toBe(true);
  });

  it('an org override takes precedence over the global default', async () => {
    await prisma.organisationFeatureFlag.create({
      data: { organisationId: orgId, flagKey: 'beta-dashboard', enabled: true },
    });
    featureFlags._clearCacheForTests();

    expect(await featureFlags.isEnabled('beta-dashboard', orgId)).toBe(true);
    // a different org with no override still sees the global default
    expect(await featureFlags.isEnabled('beta-dashboard', secondOrgId)).toBe(false);
  });

  it('defaults to false (fail closed) for an unknown flag key', async () => {
    expect(await featureFlags.isEnabled('this-flag-does-not-exist')).toBe(false);
  });

  it('works with no organisationId at all (global-only check)', async () => {
    expect(await featureFlags.isEnabled('always-on-thing')).toBe(true);
  });
});

describe('GET /api/organisations/:orgId/feature-flags', () => {
  it('lists flags with effective state for the org', async () => {
    const res = await request(app)
      .get(`/api/organisations/${orgId}/feature-flags`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const betaFlag = res.body.flags.find((f) => f.key === 'beta-dashboard');
    expect(betaFlag).toMatchObject({
      globalDefault: false,
      enabled: true,       // overridden true for this org from the previous test
      isOverridden: true,
    });
  });

  it('rejects a non-admin org member', async () => {
    const { hashToken } = require('../lib/tokenHash');
    const rawToken = 'flag-test-member-token';
    await prisma.invite.create({
      data: {
        email: 'flag-member@example.com', role: 'MEMBER',
        tokenHash: hashToken(rawToken), organisationId: orgId,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await request(app).post('/api/members/accept-invite').send({
      token: rawToken, password: 'Password123!',
      firstName: 'Flag', lastName: 'Member',
    });
    const login = await request(app).post('/api/auth/login').send({
      email: 'flag-member@example.com', password: 'Password123!',
    });
    const memberToken = login.body.accessToken;

    const res = await request(app)
      .get(`/api/organisations/${orgId}/feature-flags`)
      .set('Authorization', `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/organisations/:orgId/feature-flags/:key', () => {
  it('sets an override for the org', async () => {
    const res = await request(app)
      .put(`/api/organisations/${orgId}/feature-flags/always-on-thing`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'always-on-thing', enabled: false, isOverridden: true });

    const row = await prisma.organisationFeatureFlag.findUnique({
      where: { organisationId_flagKey: { organisationId: orgId, flagKey: 'always-on-thing' } },
    });
    expect(row.enabled).toBe(false);
  });

  it('rejects a non-boolean enabled value', async () => {
    const res = await request(app)
      .put(`/api/organisations/${orgId}/feature-flags/always-on-thing`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: 'yes' });
    expect(res.status).toBe(422);
  });

  it('404s for an unknown flag key', async () => {
    const res = await request(app)
      .put(`/api/organisations/${orgId}/feature-flags/does-not-exist`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(404);
  });

  it("cannot set an override for another org's id", async () => {
    const res = await request(app)
      .put(`/api/organisations/${secondOrgId}/feature-flags/always-on-thing`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(403); // not a member of secondOrgId
  });
});

describe('DELETE /api/organisations/:orgId/feature-flags/:key', () => {
  it('clears an override, reverting to the global default', async () => {
    const res = await request(app)
      .delete(`/api/organisations/${orgId}/feature-flags/always-on-thing`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);

    const row = await prisma.organisationFeatureFlag.findUnique({
      where: { organisationId_flagKey: { organisationId: orgId, flagKey: 'always-on-thing' } },
    });
    expect(row).toBeNull();
  });

  it('404s when there is nothing to clear', async () => {
    const res = await request(app)
      .delete(`/api/organisations/${orgId}/feature-flags/always-on-thing`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });
});
