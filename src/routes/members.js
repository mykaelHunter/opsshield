const router = require('express').Router();
const { body } = require('express-validator');
const { authenticate, requireOrgMember, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const membersController = require('../controllers/members');

router.post('/org/:orgId/invite',
  authenticate, requireOrgMember, requireAdmin,
  [
    body('email').isEmail().normalizeEmail(),
    body('role').optional().isIn(['ADMIN', 'MEMBER']),
  ],
  validate,
  membersController.invite
);

router.post('/accept-invite',
  [
    body('token').notEmpty(),
    body('password').optional().isLength({ min: 8 }),
  ],
  validate,
  membersController.acceptInvite
);

router.delete('/org/:orgId/:memberId',
  authenticate, requireOrgMember, requireAdmin,
  membersController.remove
);

router.patch('/org/:orgId/:memberId/role',
  authenticate, requireOrgMember, requireAdmin,
  [body('role').isIn(['ADMIN', 'MEMBER'])],
  validate,
  membersController.updateRole
);

module.exports = router;
