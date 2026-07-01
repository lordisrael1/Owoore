import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorise';
import { signatoryController } from './signatories.controller';

/**
 * signatory.routes.ts
 *
 * GET    /signatories          → list signatories
 * POST   /signatories          → add signatory (ADMIN only)
 * PATCH  /signatories/:id      → update signatory (ADMIN only)
 * DELETE /signatories/:id      → deactivate signatory (ADMIN only)
 * GET    /signatories/policy   → get payout policy
 * PATCH  /signatories/policy   → update payout policy (ADMIN only)
 */
const router = Router();

router.use(authenticateAdmin);

router.get('/',         signatoryController.list);
router.post('/',        requireRole(['ADMIN']), signatoryController.create);
router.get('/policy',   signatoryController.getPolicy);
router.patch('/policy', requireRole(['ADMIN']), signatoryController.updatePolicy);
router.patch('/:id',    requireRole(['ADMIN']), signatoryController.update);
router.delete('/:id',   requireRole(['ADMIN']), signatoryController.deactivate);

export default router;