const router = require('express').Router();
const { body } = require('express-validator');
const { authenticate, requireOrgMember, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const billingController = require('../controllers/billing');

router.get('/org/:orgId',
  authenticate, requireOrgMember,
  billingController.history
);

router.post('/org/:orgId/initiate',
  authenticate, requireOrgMember, requireAdmin,
  [body('plan').isIn(['STARTER', 'PRO'])],
  validate,
  billingController.initiate
);

module.exports = router;
