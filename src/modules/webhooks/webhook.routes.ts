import { Router } from 'express';
import { webhookVerify } from '../../middleware/webhookVerify';
import { webhookController } from './webhook.controller';
 
/**
 * webhook.routes.ts
 *
 * CRITICAL: This route must use express.raw() NOT express.json().
 * The HMAC signature is computed over the raw request body bytes.
 * Parsing the body as JSON first changes the byte representation
 * and will cause ALL signature checks to fail.
 *
 * Route: POST /api/v1/webhooks/nomba
 * Auth:  Public — verified via HMAC signature in webhookVerify middleware
 */
const router = Router();
 
router.post(
  '/nomba',
  (req,res,next)=>{
   console.log("NOMBA HIT");
   next();
 },
  // express.raw() is applied in app.ts specifically for this route
  // before express.json() — see app.ts for the ordering
  webhookVerify,
  webhookController.handle,
);
 
export default router;
 