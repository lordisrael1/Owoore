import { Router } from 'express';
import { authenticateAdmin } from '../../middleware/authenticate';
import { generalRateLimiter } from '../../middleware/ratelimiter';
import { bankController } from './bank.controller';

const router = Router();

router.use(authenticateAdmin, generalRateLimiter);

router.get('/', bankController.listBanks);
router.post('/lookup', bankController.lookupAccount);

export default router;
