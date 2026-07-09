const router = require('express').Router();
const { body, param } = require('express-validator');
const { authenticate, requireOrgMember, requireAdmin } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const taskController = require('../controllers/tasks');

// All task routes require authentication and org membership
// requireOrgMember is the IDOR defence — it scopes every request to
// the authenticated user's organisation before any data is touched

router.get('/org/:orgId',
  authenticate, requireOrgMember,
  taskController.list
);

router.post('/org/:orgId',
  authenticate, requireOrgMember,
  [
    body('title').trim().notEmpty().isLength({ max: 200 }),
    body('description').optional().trim().isLength({ max: 2000 }),
    body('requiresApproval').optional().isBoolean(),
    body('assignedToId').optional().isUUID(),
  ],
  validate,
  taskController.create
);

router.get('/org/:orgId/:taskId',
  authenticate, requireOrgMember,
  taskController.get
);

router.patch('/org/:orgId/:taskId',
  authenticate, requireOrgMember,
  [
    // Allowlist — ONLY these fields can be updated. No role, no orgId, no createdById.
    body('title').optional().trim().notEmpty().isLength({ max: 200 }),
    body('description').optional().trim().isLength({ max: 2000 }),
    body('status').optional().isIn(['PENDING','IN_PROGRESS','AWAITING_APPROVAL','DONE']),
    body('assignedToId').optional().isUUID(),
  ],
  validate,
  taskController.update
);

router.delete('/org/:orgId/:taskId',
  authenticate, requireOrgMember, requireAdmin,
  taskController.remove
);

// Approval flow
router.post('/org/:orgId/:taskId/approve',
  authenticate, requireOrgMember, requireAdmin,
  [body('note').optional().trim().isLength({ max: 500 })],
  validate,
  taskController.approve
);

router.post('/org/:orgId/:taskId/reject',
  authenticate, requireOrgMember, requireAdmin,
  [body('note').optional().trim().isLength({ max: 500 })],
  validate,
  taskController.reject
);

module.exports = router;
