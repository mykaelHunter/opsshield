const axios  = require('axios');
const prisma = require('../lib/prisma');
const audit  = require('../lib/audit');
const logger = require('../lib/logger');

const PLANS = {
  STARTER: { amount: 500000, label: 'Starter — ₦5,000/month' }, // amount in kobo
  PRO:     { amount: 900000, label: 'Pro — ₦9,000/month' },
};

async function history(req, res, next) {
  try {
    const billing = await prisma.billing.findMany({
      where:   { organisationId: req.organisation.id },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ billing });
  } catch (err) { next(err); }
}

async function initiate(req, res, next) {
  try {
    const { plan } = req.body;
    const planConfig = PLANS[plan];
    if (!planConfig) return res.status(400).json({ error: 'Invalid plan' });

    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(500).json({ error: 'Payment system not configured' });
    }

    // Initiate Paystack transaction
    const response = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email:     req.user.email,
        amount:    planConfig.amount,
        currency:  'NGN',
        metadata: {
          organisationId: req.organisation.id,
          plan,
          userId:         req.user.id,
          // Paystack will include this metadata in the webhook
        },
        callback_url: `${process.env.FRONTEND_URL}/billing/callback`,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );

    const { authorization_url, reference } = response.data.data;

    await audit.log({
      action:         'billing.initiate',
      resource:       'billing',
      actor:          req.user,
      organisationId: req.organisation.id,
      metadata:       { plan, reference },
      ipAddress:      req.ip,
    });

    return res.json({ url: authorization_url, reference });
  } catch (err) {
    logger.error('Paystack initiation failed', { err: err.message });
    next(err);
  }
}

module.exports = { history, initiate };
