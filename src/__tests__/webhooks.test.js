const request = require('supertest');
const crypto  = require('crypto');
const app     = require('../app');
const prisma  = require('../lib/prisma');

// webhooks.js reads PAYSTACK_SECRET_KEY into a module-level constant at
// require time (not per-request), so by the time this file runs, app.js
// has already captured whatever value jest.setup.js's dotenv.config()
// loaded from .env. Overriding process.env in beforeAll would be too late
// and would only desync our signatures from what the route expects — so
// we sign with the same value the route already has, not a fake override.
const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;

if (!PAYSTACK_SECRET) {
  throw new Error(
    'PAYSTACK_SECRET_KEY must be set in .env for webhook tests to sign requests correctly.'
  );
}

function sign(bodyString) {
  return crypto.createHmac('sha512', PAYSTACK_SECRET).update(bodyString).digest('hex');
}

// Sends a raw JSON body with a correctly (or incorrectly) computed
// signature, mirroring exactly what Paystack does — sign the raw bytes,
// not a parsed/re-serialized object.
function postWebhook(payload, { signature, noSignature = false } = {}) {
  const bodyString = JSON.stringify(payload);
  const req = request(app)
    .post('/api/webhooks/paystack')
    .set('Content-Type', 'application/json');

  if (!noSignature) {
    req.set('x-paystack-signature', signature || sign(bodyString));
  }

  return req.send(bodyString);
}

beforeAll(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM "AuditLog"');
  await prisma.$executeRawUnsafe('DELETE FROM "Billing"');
  await prisma.$executeRawUnsafe('DELETE FROM "RefreshToken"');
  await prisma.$executeRawUnsafe('DELETE FROM "Member"');
  await prisma.$executeRawUnsafe('DELETE FROM "Organisation"');
  await prisma.$executeRawUnsafe('DELETE FROM "User"');
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Paystack webhook — signature verification', () => {
  it('rejects a request with no signature header', async () => {
    const res = await postWebhook({ event: 'charge.success', data: {} }, { noSignature: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Missing signature');
  });

  it('rejects a request with a wrong signature', async () => {
    const res = await postWebhook(
      { event: 'charge.success', data: {} },
      { signature: sign('some completely different body') }
    );
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid signature');
  });

  it('rejects a malformed hex signature without throwing', async () => {
    const res = await postWebhook(
      { event: 'charge.success', data: {} },
      { signature: 'not-valid-hex' }
    );
    expect(res.status).toBe(401);
  });

  it('accepts a correctly signed request', async () => {
    const res = await postWebhook({ event: 'unhandled.event', data: {} });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});

describe('charge.success', () => {
  let orgId;

  beforeAll(async () => {
    const org = await prisma.organisation.create({
      data: { name: 'Charge Org', slug: 'charge-org' },
    });
    orgId = org.id;
  });

  it('records the billing row and upgrades the org plan', async () => {
    const res = await postWebhook({
      event: 'charge.success',
      data: {
        reference: 'ref_charge_1',
        amount: 500000,
        currency: 'NGN',
        metadata: { organisationId: orgId, plan: 'STARTER' },
      },
    });
    expect(res.status).toBe(200);

    const org = await prisma.organisation.findUnique({ where: { id: orgId } });
    expect(org.plan).toBe('STARTER');
    expect(org.paystackRef).toBe('ref_charge_1');

    const billing = await prisma.billing.findUnique({ where: { paystackRef: 'ref_charge_1' } });
    expect(billing.status).toBe('SUCCESS');
    expect(billing.amount).toBe(500000);

    const auditEntry = await prisma.auditLog.findFirst({
      where: { action: 'billing.charge.success', resourceId: 'ref_charge_1' },
    });
    expect(auditEntry).not.toBeNull();
  });

  it('does not throw and skips processing when metadata is missing organisationId', async () => {
    const res = await postWebhook({
      event: 'charge.success',
      data: { reference: 'ref_charge_incomplete', amount: 1000, currency: 'NGN', metadata: {} },
    });
    // Always 200 to Paystack even when the handler can't process the event —
    // this is intentional (see comment in webhooks.js) to avoid retry storms.
    expect(res.status).toBe(200);
    const billing = await prisma.billing.findUnique({
      where: { paystackRef: 'ref_charge_incomplete' },
    });
    expect(billing).toBeNull();
  });
});

describe('subscription.create', () => {
  let orgId;

  beforeAll(async () => {
    const org = await prisma.organisation.create({
      data: {
        name: 'Sub Create Org',
        slug: 'sub-create-org',
        paystackRef: 'ref_sub_create',
      },
    });
    orgId = org.id;
  });

  it('resolves the org by customer email and marks the subscription active', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'subcreate@example.com',
        passwordHash: 'not-a-real-hash',
        firstName: 'Sub',
        lastName: 'Create',
      },
    });
    await prisma.member.create({
      data: { userId: user.id, organisationId: orgId, role: 'ADMIN' },
    });

    const res = await postWebhook({
      event: 'subscription.create',
      data: {
        subscription_code: 'SUB_create_001',
        customer: { customer_code: 'CUS_create_001', email: 'subcreate@example.com' },
        plan: { plan_code: 'PLN_unknown' },
      },
    });
    expect(res.status).toBe(200);

    const org = await prisma.organisation.findUnique({ where: { id: orgId } });
    expect(org.paystackSubscriptionCode).toBe('SUB_create_001');
    expect(org.paystackCustomerCode).toBe('CUS_create_001');
    expect(org.subscriptionStatus).toBe('ACTIVE');

    const auditEntry = await prisma.auditLog.findFirst({
      where: { action: 'billing.subscription.create', resourceId: 'SUB_create_001' },
    });
    expect(auditEntry).not.toBeNull();
  });

  it('logs and skips when the org cannot be resolved by any method', async () => {
    const res = await postWebhook({
      event: 'subscription.create',
      data: {
        subscription_code: 'SUB_orphan',
        customer: { customer_code: 'CUS_orphan', email: 'nobody-registered@example.com' },
        plan: { plan_code: 'PLN_unknown' },
      },
    });
    expect(res.status).toBe(200);
    const org = await prisma.organisation.findUnique({
      where: { paystackSubscriptionCode: 'SUB_orphan' },
    });
    expect(org).toBeNull();
  });
});

describe('subscription.disable', () => {
  let orgId;

  beforeAll(async () => {
    const org = await prisma.organisation.create({
      data: {
        name: 'Sub Disable Org',
        slug: 'sub-disable-org',
        plan: 'PRO',
        paystackSubscriptionCode: 'SUB_disable_001',
        subscriptionStatus: 'ACTIVE',
      },
    });
    orgId = org.id;
  });

  it('downgrades the org to FREE and marks the subscription disabled', async () => {
    const res = await postWebhook({
      event: 'subscription.disable',
      data: { subscription_code: 'SUB_disable_001', customer: {} },
    });
    expect(res.status).toBe(200);

    const org = await prisma.organisation.findUnique({ where: { id: orgId } });
    expect(org.plan).toBe('FREE');
    expect(org.subscriptionStatus).toBe('DISABLED');

    const auditEntry = await prisma.auditLog.findFirst({
      where: { action: 'billing.subscription.disable', resourceId: 'SUB_disable_001' },
    });
    expect(auditEntry).not.toBeNull();
    expect(auditEntry.metadata.downgradedTo).toBe('FREE');
  });

  it('does not downgrade an org it cannot resolve', async () => {
    const before = await prisma.organisation.findUnique({ where: { id: orgId } });
    const res = await postWebhook({
      event: 'subscription.disable',
      data: { subscription_code: 'SUB_never_seen', customer: {} },
    });
    expect(res.status).toBe(200);
    const after = await prisma.organisation.findUnique({ where: { id: orgId } });
    expect(after.plan).toBe(before.plan);
  });
});

describe('handler errors do not break the Paystack contract', () => {
  it('still returns 200 if an event handler throws internally', async () => {
    // organisationId that looks valid but doesn't exist — the underlying
    // prisma.organisation.update will reject, which the outer try/catch
    // in the route must swallow and still ack with 200.
    const res = await postWebhook({
      event: 'charge.success',
      data: {
        reference: 'ref_will_error',
        amount: 100,
        currency: 'NGN',
        metadata: { organisationId: 'does-not-exist', plan: 'STARTER' },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.received).toBe(true);
  });
});
