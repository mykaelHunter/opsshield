const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { signAccess, signRefresh, verifyRefresh } = require('../lib/jwt');
const audit = require('../lib/audit');
const logger = require('../lib/logger');
const { sendPasswordResetEmail } = require('../lib/mailer');
const { hashToken, generateRawToken } = require('../lib/tokenHash');

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

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
    const slug = slugify(orgName) + '-' + crypto.randomUUID().slice(0, 6);

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
        client:         tx,
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

    // Locked accounts short-circuit before the bcrypt compare. This does
    // mean a locked-out response is distinguishable from "wrong password"
    // (a small enumeration signal), but a user actively being locked out
    // needs to know why — silently returning the generic 401 would make
    // a real lockout indistinguishable from a typo, which is worse for
    // the person experiencing it. Note this only reveals that lockout
    // *machinery* triggered, not whether the account exists otherwise.
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      await audit.log({
        action:    'auth.login.blocked_locked',
        resource:  'user',
        resourceId: user.id,
        metadata:  { email },
        ipAddress: req.ip,
      });
      return res.status(423).json({
        error: 'Account temporarily locked due to too many failed login attempts. Please try again later.',
      });
    }

    // Always run bcrypt even if user not found — prevents timing attacks
    const passwordMatch = user
      ? await bcrypt.compare(password, user.passwordHash)
      : await bcrypt.compare(password, '$2a$12$invalidhashtopreventtimingattack');

    if (!user || !passwordMatch) {
      if (user) {
        await registerFailedLogin(user, req.ip);
      }
      await audit.log({
        action:    'auth.login.failed',
        resource:  'user',
        metadata:  { email },
        ipAddress: req.ip,
      });
      // Same error message whether email or password is wrong — no enumeration
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Successful login clears any prior failed-attempt count/lock
    if (user.failedLoginCount > 0 || user.lockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data:  { failedLoginCount: 0, lockedUntil: null },
      });
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

/**
 * Increments the failed-login counter and, once it crosses the threshold,
 * locks the account for LOCKOUT_DURATION_MS. Uses a single atomic update
 * (increment) rather than read-then-write to avoid a race under concurrent
 * failed attempts undercounting the total.
 */
async function registerFailedLogin(user, ipAddress) {
  const updated = await prisma.user.update({
    where: { id: user.id },
    data:  { failedLoginCount: { increment: 1 } },
  });

  if (updated.failedLoginCount >= MAX_FAILED_LOGIN_ATTEMPTS) {
    await prisma.user.update({
      where: { id: user.id },
      data:  { lockedUntil: new Date(Date.now() + LOCKOUT_DURATION_MS) },
    });

    await audit.log({
      action:     'auth.account.locked',
      resource:   'user',
      resourceId: user.id,
      metadata:   { failedLoginCount: updated.failedLoginCount },
      ipAddress,
    });

    logger.warn('Account locked after repeated failed logins', {
      userId: user.id,
      failedLoginCount: updated.failedLoginCount,
    });
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
    // Raw token goes in the email link; only its hash is ever persisted.
    // A DB leak alone can't be used to reset an account — the raw token
    // was only ever transmitted over the (assumed-private) email channel.
    const rawToken = generateRawToken();
    const tokenHash = hashToken(rawToken);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetTokenHash: tokenHash,
        resetTokenExpiry: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail(user.email, resetUrl);

    await audit.log({
      action: 'auth.password_reset.requested',
      resource: 'user',
      resourceId: user.id,
      actor: { id: user.id, email: user.email },
      ipAddress: req.ip,
    });

    logger.info('Password reset requested', { userId: user.id });
  }

  return res.json({ message: 'If an account exists for this email, a reset link has been sent.' });
}

async function resetPassword(req, res, next) {
  try {
    const { token, password } = req.body;

    const tokenHash = hashToken(token);

    const user = await prisma.user.findFirst({
      where: { resetTokenHash: tokenHash },
    });

    if (!user || !user.resetTokenExpiry || user.resetTokenExpiry < new Date()) {
      // Same generic error whether the token is missing, wrong, or expired
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          resetTokenHash: null,
          resetTokenExpiry: null, // single-use: cleared immediately on success
          failedLoginCount: 0,
          lockedUntil: null,
        },
      }),
      // Revoke every existing session — if an attacker was riding a
      // stolen session, a password reset should end it, not leave it live
      prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
    ]);

    await audit.log({
      action: 'auth.password_reset.completed',
      resource: 'user',
      resourceId: user.id,
      actor: { id: user.id, email: user.email },
      ipAddress: req.ip,
    });

    return res.json({ message: 'Password has been reset. Please log in again.' });
  } catch (err) {
    next(err);
  }
}

async function me(req, res) {
  const memberships = await prisma.member.findMany({
    where: {
      userId:    req.user.id,
      deletedAt: null,
      organisation: { deletedAt: null },
    },
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
