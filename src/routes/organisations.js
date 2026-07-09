const router = require('express').Router();
const { body } = require('express-validator');
const { authenticate, requireOrgMember, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const orgController = require('../controllers/organisations');

router.get('/:orgId',
  authenticate, requireOrgMember,
  orgController.get
);

router.patch('/:orgId',
  authenticate, requireOrgMember, requireAdmin,
  [body('name').optional().trim().notEmpty().isLength({ max: 100 })],
  validate,
  orgController.update
);

router.get('/:orgId/audit-log',
  authenticate, requireOrgMember, requireAdmin,
  orgController.auditLog
);

router.get('/:orgId/audit-log/verify',
  authenticate, requireOrgMember, requireAdmin,
  orgController.verifyAuditChain
);

module.exports = router;
