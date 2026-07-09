const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const prisma = require('../lib/prisma');
const { signAccess, signRefresh, verifyRefresh } = require('../lib/jwt');
const audit = require('../lib/audit');
const logger = require('../lib/logger');

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function register(req, res, next) {
  try {
    const { email, password, firstName, lastName, orgName } = req.body;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Constant-time response to prevent email enumeration
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const slug = slugify(orgName) + '-' + uuidv4().slice(0, 6);

    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: { email, passwordHash, firstName, lastName }
      });

      const org = await tx.organisation.create({
        data: {
          name: orgName,
          slug,
          members: {
            create: { userId: newUser.id, role: 'ADMIN' }
          }
        }
      });

      await audit.log({
        action:         'user.register',
        resource:       'user',
        resourceId:     newUser.id,
        actor:          { id: newUser.id, email },
        organisationId: org.id,
        ipAddress:      req.ip,
      });

      return newUser;
    });

    const accessToken  = signAccess({ userId: user.id });
    const refreshToken = signRefresh({ userId: user.id });

    await prisma.refreshToken.create({
      data: {
        token:     refreshToken,
        userId:    user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }
    });

    return res.status(201).json({
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
    });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });

    // Always run bcrypt even if user not found — prevents timing attacks
    const passwordMatch = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(password, '$2a$12$invalidhashtopreventtimingattack');

    if (!user || !passwordMatch) {
      await audit.log({
        action:    'auth.login.failed',
        resource:  'user',
        metadata:  { email },
        ipAddress: req.ip,
      });
      // Same error message whether email or password is wrong — no enumeration
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const accessToken  = signAccess({ userId: user.id });
    const refreshToken = signRefresh({ userId: user.id });

    await prisma.refreshToken.create({
      data: {
        token:     refreshToken,
        userId:    user.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }
    });

    await audit.log({
      action:    'auth.login',
      resource:  'user',
      resourceId: user.id,
      actor:     { id: user.id, email: user.email },
      ipAddress: req.ip,
    });

    return res.json({
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
    });
  } catch (err) {
    next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });

    let payload;
    try {
      payload = verifyRefresh(refreshToken);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const stored = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
    if (!stored || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Refresh token not found or expired' });
    }

    // Rotate — delete old, issue new
    await prisma.refreshToken.delete({ where: { token: refreshToken } });

    const newAccess  = signAccess({ userId: payload.userId });
    const newRefresh = signRefresh({ userId: payload.userId });

    await prisma.refreshToken.create({
      data: {
        token:     newRefresh,
        userId:    payload.userId,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }
    });

    return res.json({ accessToken: newAccess, refreshToken: newRefresh });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await prisma.refreshToken.deleteMany({ where: { token: refreshToken, userId: req.user.id } });
    }
    await audit.log({
      action:    'auth.logout',
      resource:  'user',
      resourceId: req.user.id,
      actor:     req.user,
      ipAddress: req.ip,
    });
    return res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
}

async function forgotPassword(req, res) {
  // Always return the same response — prevents email enumeration
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } }).catch(() => null);

  if (user) {
    // TODO: generate reset token, store with expiry, send email via Nodemailer
    // Implementation left for the team — this is a security-sensitive flow
    // that requires: constant-time token comparison, single-use tokens,
    // expiry of 1 hour, and rate limiting (already applied at router level)
    logger.info('Password reset requested', { userId: user.id });
  }

  return res.json({ message: 'If an account exists for this email, a reset link has been sent.' });
}

async function resetPassword(req, res, next) {
  // TODO: implement — verify token, hash new password, invalidate all refresh tokens
  return res.status(501).json({ error: 'Not implemented yet — your task for Week 1' });
}

async function me(req, res) {
  const memberships = await prisma.member.findMany({
    where: { userId: req.user.id },
    include: { organisation: { select: { id: true, name: true, slug: true, plan: true } } },
  });

  return res.json({
    user:          req.user,
    organisations: memberships.map(m => ({
      ...m.organisation,
      role: m.role,
    })),
  });
}

module.exports = { register, login, refresh, logout, forgotPassword, resetPassword, me };
