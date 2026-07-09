const request = require('supertest');
const app     = require('../src/app');
const prisma  = require('../src/lib/prisma');

beforeAll(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM "AuditLog"');
  await prisma.$executeRawUnsafe('DELETE FROM "RefreshToken"');
  await prisma.$executeRawUnsafe('DELETE FROM "Member"');
  await prisma.$executeRawUnsafe('DELETE FROM "Organisation"');
  await prisma.$executeRawUnsafe('DELETE FROM "User"');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/auth/register', () => {
  it('registers a new user and returns tokens', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email:     'test@example.com',
      password:  'Password123!',
      firstName: 'Test',
      lastName:  'User',
      orgName:   'Test Org',
    });
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeDefined();
    expect(res.body.refreshToken).toBeDefined();
    expect(res.body.user.email).toBe('test@example.com');
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('rejects duplicate email with 409', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email:     'test@example.com',
      password:  'Password123!',
      firstName: 'Test',
      lastName:  'User',
      orgName:   'Another Org',
    });
    expect(res.status).toBe(409);
  });

  it('rejects short password with 422', async () => {
    const res = await request(app).post('/api/auth/register').send({
      email:     'new@example.com',
      password:  'short',
      firstName: 'Test',
      lastName:  'User',
      orgName:   'Test Org',
    });
    expect(res.status).toBe(422);
  });
});

describe('POST /api/auth/login', () => {
  it('returns tokens on valid credentials', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email:    'test@example.com',
      password: 'Password123!',
    });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();
  });

  it('returns 401 on wrong password — same error as wrong email', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email:    'test@example.com',
      password: 'wrongpassword',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });

  it('returns 401 on unknown email — same error as wrong password', async () => {
    const res = await request(app).post('/api/auth/login').send({
      email:    'nobody@example.com',
      password: 'Password123!',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid email or password');
  });
});

describe('IDOR protection', () => {
  let tokenA, tokenB, orgAId, orgBId;

  beforeAll(async () => {
    const regA = await request(app).post('/api/auth/register').send({
      email: 'usera@example.com', password: 'Password123!',
      firstName: 'A', lastName: 'User', orgName: 'Org A',
    });
    tokenA = regA.body.accessToken;
    const meA = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenA}`);
    orgAId = meA.body.organisations[0].id;

    const regB = await request(app).post('/api/auth/register').send({
      email: 'userb@example.com', password: 'Password123!',
      firstName: 'B', lastName: 'User', orgName: 'Org B',
    });
    tokenB = regB.body.accessToken;
    const meB = await request(app).get('/api/auth/me')
      .set('Authorization', `Bearer ${tokenB}`);
    orgBId = meB.body.organisations[0].id;
  });

  it('user A cannot access org B tasks', async () => {
    const res = await request(app)
      .get(`/api/tasks/org/${orgBId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(res.status).toBe(403);
  });

  it('user B cannot access org A data', async () => {
    const res = await request(app)
      .get(`/api/organisations/${orgAId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(res.status).toBe(403);
  });
});
