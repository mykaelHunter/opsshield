const router  = require('express').Router();
const crypto  = require('crypto');
const prisma  = require('../lib/prisma');
const audit   = require('../lib/audit');
const logger  = require('../lib/logger');

/**
 * Paystack Webhook Handler
 *
 * SECURITY — This is the most critical security control in the billing system.
 * Without HMAC-SHA512 signature verification, any attacker who knows this
 * URL can POST a fake charge.success event and get a free plan upgrade.
 *
 * Paystack signs every webhook with HMAC-SHA512 using your secret key.
 * We verify the signature before processing any event.
 *
 * The route receives raw body (configured in app.js) so the HMAC
 * is computed over the exact bytes Paystack sent.
 *
 * NOTE: the secret is read from process.env on every request, not cached
 * at module load. If it were captured once at require time, rotating it
 * via Secrets Manager / ECS task refresh would silently have no effect
 * until the process restarted — a subtle way to end up validating
 * against a stale secret.
 */
router.post('/paystack', async (req, res) => {
  const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY;
  if (!PAYSTACK_SECRET) {
    logger.error('PAYSTACK_SECRET_KEY not configured — rejecting webhook');
    return res.status(500).end();
  }

  // Step 1: Verify signature BEFORE reading the body
  const signature = req.headers['x-paystack-signature'];
  if (!signature) {
    logger.warn('Paystack webhook received without signature', { ip: req.ip });
    return res.status(400).json({ error: 'Missing signature' });
  }

  const expectedSig = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(req.body) // raw Buffer
    .digest('hex');

  // Constant-time comparison — prevents timing attacks
  const sigBuffer      = Buffer.from(signature,    'hex');
  const expectedBuffer = Buffer.from(expectedSig,  'hex');

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    logger.warn('Paystack webhook signature mismatch', { ip: req.ip });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Step 2: Parse and handle the verified event
  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  logger.info('Paystack webhook received', { event: event.event });

  try {
    switch (event.event) {
      case 'charge.success':
        await handleChargeSuccess(event.data);
        break;
      case 'subscription.create':
        await handleSubscriptionCreate(event.data);
        break;
      case 'subscription.disable':
        await handleSubscriptionDisable(event.data);
        break;
      default:
        logger.info('Unhandled Paystack event', { event: event.event });
    }
  } catch (err) {
    logger.error('Webhook handler error', { event: event.event, err: err.message });
    // Return 200 to Paystack even on handler error — prevents infinite retries
    // The error is logged and can be replayed manually
  }

  // Always return 200 quickly to Paystack
  return res.status(200).json({ received: true });
});

async function handleChargeSuccess(data) {
  const { reference, amount, currency, metadata } = data;
  const organisationId = metadata?.organisationId;
  const plan           = metadata?.plan;

  if (!organisationId || !plan) {
    logger.warn('charge.success missing organisationId or plan in metadata', { reference });
    return;
  }

  await prisma.$transaction([
    prisma.billing.create({
      data: {
        paystackRef:    reference,
        paystackEvent:  'charge.success',
        amount,
        currency,
        status:         'SUCCESS',
        plan,
        organisationId,
      }
    }),
    prisma.organisation.update({
      where: { id: organisationId },
      data:  { plan, paystackRef: reference },
    }),
  ]);

  await audit.log({
    action:         'billing.charge.success',
    resource:       'billing',
    resourceId:     reference,
    organisationId,
    metadata:       { amount, currency, plan },
  });

  logger.info('Payment processed', { organisationId, plan, amount });
}

async function handleSubscriptionCreate(data) {
  const { subscription_code: subscriptionCode, customer, plan } = data;
  const organisationId = await resolveOrganisationId(data);

  if (!organisationId) {
    logger.warn('subscription.create: could not resolve organisation', {
      subscriptionCode,
      customerCode: customer?.customer_code,
    });
    return;
  }

  await prisma.organisation.update({
    where: { id: organisationId },
    data: {
      paystackSubscriptionCode: subscriptionCode,
      paystackCustomerCode:     customer?.customer_code,
      subscriptionStatus:       'ACTIVE',
      ...(plan?.plan_code ? { plan: mapPaystackPlan(plan.plan_code) } : {}),
    },
  });

  await audit.log({
    action:     'billing.subscription.create',
    resource:   'billing',
    resourceId: subscriptionCode,
    organisationId,
    metadata:   { subscriptionCode, planCode: plan?.plan_code },
  });

  logger.info('Subscription created and org updated', { organisationId, subscriptionCode });
}

async function handleSubscriptionDisable(data) {
  const { subscription_code: subscriptionCode } = data;
  const organisationId = await resolveOrganisationId(data);

  if (!organisationId) {
    logger.warn('subscription.disable: could not resolve organisation', { subscriptionCode });
    return;
  }

  await prisma.organisation.update({
    where: { id: organisationId },
    data: {
      subscriptionStatus: 'DISABLED',
      plan:               'FREE',
    },
  });

  await audit.log({
    action:     'billing.subscription.disable',
    resource:   'billing',
    resourceId: subscriptionCode,
    organisationId,
    metadata:   { subscriptionCode, downgradedTo: 'FREE' },
  });

  logger.info('Subscription disabled, org downgraded to FREE', { organisationId, subscriptionCode });
}

/**
 * Paystack subscription events don't carry our internal organisationId —
 * only a subscription_code and the customer's email/customer_code. We
 * resolve back to our org via whichever we already have on file, falling
 * back to email lookup through the org's most recent successful charge.
 */
async function resolveOrganisationId(data) {
  const { subscription_code: subscriptionCode, customer } = data;

  if (subscriptionCode) {
    const bySubCode = await prisma.organisation.findUnique({
      where: { paystackSubscriptionCode: subscriptionCode },
      select: { id: true },
    });
    if (bySubCode) return bySubCode.id;
  }

  if (customer?.customer_code) {
    const byCustomerCode = await prisma.organisation.findFirst({
      where: { paystackCustomerCode: customer.customer_code },
      select: { id: true },
    });
    if (byCustomerCode) return byCustomerCode.id;
  }

  if (customer?.email) {
    const org = await prisma.organisation.findFirst({
      where: { members: { some: { user: { email: customer.email } } } },
      select: { id: true },
    });
    if (org) return org.id;
  }

  return null;
}

function mapPaystackPlan(planCode) {
  const map = {
    [process.env.PAYSTACK_PLAN_STARTER]: 'STARTER',
    [process.env.PAYSTACK_PLAN_PRO]:      'PRO',
  };
  return map[planCode] || 'STARTER';
}

module.exports = router;
