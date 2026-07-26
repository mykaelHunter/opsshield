const request = require('supertest');
const axios   = require('axios');
const app     = require('../app');
const prisma  = require('../lib/prisma');

// billing.initiate() calls the real Paystack API via axios — mock it so
// tests never make a network call and never need a real secret key.
jest.mock('axios');

let adminToken, adminId, orgId, memberToken;
let originalPaystackKey;

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

  originalPaystackKey = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = 'sk_test_fake_key_for_tests';

  const reg = await request(app).post('/api/auth/register').send({
    email: 'billing-admin@example.com', password: 'Password123!',
    firstName: 'Billing', lastName: 'Admin', orgName: 'Billing Org',
  });
  adminToken = reg.body.accessToken;
  adminId    = reg.body.user.id;

  const me = await request(app).get('/api/auth/me')
    .set('Authorization', `Bearer ${adminToken}`);
  orgId = me.body.organisations[0].id;

  const { hashToken } = require('../lib/tokenHash');
  const rawToken = 'billing-member-token';
  await prisma.invite.create({
    data: {
      email: 'billing-member@example.com',
      role: 'MEMBER',
      tokenHash: hashToken(rawToken),
      organisationId: orgId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await request(app).post('/api/members/accept-invite').send({
    token: rawToken, password: 'Password123!', firstName: 'Billing', lastName: 'Member',
  });
  const login = await request(app).post('/api/auth/login').send({
    email: 'billing-member@example.com', password: 'Password123!',
  });
  memberToken = login.body.accessToken;
});

afterEach(() => {
  jest.clearAllMocks();
});

afterAll(async () => {
  process.env.PAYSTACK_SECRET_KEY = originalPaystackKey;
  await prisma.$disconnect();
});

describe('GET /api/billing/org/:orgId', () => {
  it('returns billing history scoped to the org (empty initially)', async () => {
    const res = await request(app)
      .get(`/api/billing/org/${orgId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.billing)).toBe(true);
  });

  it('a non-member cannot read another org billing history (IDOR)', async () => {
    const outsider = await request(app).post('/api/auth/register').send({
      email: 'billing-outsider@example.com', password: 'Password123!',
      firstName: 'Out', lastName: 'Sider', orgName: 'Outsider Billing Org',
    });
    const res = await request(app)
      .get(`/api/billing/org/${orgId}`)
      .set('Authorization', `Bearer ${outsider.body.accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/billing/org/:orgId/initiate', () => {
  it('rejects an invalid plan with 422', async () => {
    const res = await request(app)
      .post(`/api/billing/org/${orgId}/initiate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plan: 'ENTERPRISE' });
    expect(res.status).toBe(422);
  });

  it('requires admin role', async () => {
    const res = await request(app)
      .post(`/api/billing/org/${orgId}/initiate`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ plan: 'STARTER' });
    expect(res.status).toBe(403);
  });

  it('returns 500 when Paystack is not configured', async () => {
    const saved = process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_SECRET_KEY;

    const res = await request(app)
      .post(`/api/billing/org/${orgId}/initiate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plan: 'STARTER' });
    expect(res.status).toBe(500);

    process.env.PAYSTACK_SECRET_KEY = saved;
  });

  it('initiates a Paystack transaction for a valid plan', async () => {
    axios.post.mockResolvedValue({
      data: {
        data: {
          authorization_url: 'https://checkout.paystack.com/abc123',
          reference:          'ref_abc123',
        },
      },
    });

    const res = await request(app)
      .post(`/api/billing/org/${orgId}/initiate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plan: 'STARTER' });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://checkout.paystack.com/abc123');
    expect(res.body.reference).toBe('ref_abc123');

    // Amount sent to Paystack should match the STARTER plan's configured
    // amount in kobo, and metadata should carry the org/user context so the
    // webhook can attribute the eventual charge correctly.
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({
        amount: 500000,
        metadata: expect.objectContaining({ organisationId: orgId, plan: 'STARTER' }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: expect.stringContaining('Bearer'),
        }),
      })
    );
  });

  it('propagates a Paystack API failure as an error response', async () => {
    axios.post.mockRejectedValue(new Error('Paystack unreachable'));

    const res = await request(app)
      .post(`/api/billing/org/${orgId}/initiate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ plan: 'PRO' });

    expect(res.status).toBe(500);
  });
});
