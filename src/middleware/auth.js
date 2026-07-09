const { verifyAccess } = require('../lib/jwt');
const prisma = require('../lib/prisma');

/**
 * Attach authenticated user to req.user
 */
async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    const payload = verifyAccess(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Verify the user is a member of the org in the URL.
 * Attaches req.member with the role.
 * CRITICAL: This is the primary defence against IDOR — every org-scoped
 * route must use this middleware. Without it, any authenticated user
 * can access any org's data by changing the URL parameter.
 */
async function requireOrgMember(req, res, next) {
  const orgId = req.params.orgId || req.body.organisationId;
  if (!orgId) return res.status(400).json({ error: 'Organisation ID required' });

  const member = await prisma.member.findUnique({
    where: {
      userId_organisationId: {
        userId:         req.user.id,
        organisationId: orgId,
      }
    },
    include: { organisation: true },
  });

  if (!member) {
    return res.status(403).json({ error: 'You are not a member of this organisation' });
  }

  req.member = member;
  req.organisation = member.organisation;
  next();
}

/**
 * Require admin role within the org.
 * Must be called after requireOrgMember.
 */
function requireAdmin(req, res, next) {
  if (req.member?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { authenticate, requireOrgMember, requireAdmin };
