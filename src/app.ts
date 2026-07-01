import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { requestLogger }  from './middleware/requestLogger';
import { errorHandler }   from './middleware/errorHandler';

// ── Route imports ─────────────────────────────────────────────────────
import healthRouter      from './modules/health/health.routes';
import authRouter        from './modules/auth/auth.routes';
import orgRouter         from './modules/organisations/org.routes';
import fundRouter        from './modules/fund/fund.routes';
import memberRouter      from './modules/members/member.routes';
import vaRouter          from './modules/virtual-accounts/va.routes';
import anonymousRouter   from './modules/anonymous/anonymous.routes';
import webhookRouter     from './modules/webhooks/webhook.routes';
import payoutRouter      from './modules/payouts/payout.routes';
import approvalRouter    from './modules/payouts/approvals/approval.routes';
import signatoryRouter   from './modules/signatories/signatories.routes';
import dashboardRouter   from './modules/dashboard/dashboard.routes';
import reportRouter      from './modules/reports/report.routes';
import adminUserRouter   from './modules/admin-users/admin-users.routes';
import bankRouter        from './modules/payouts/bank.routes';

/**
 * app.ts — Express app factory.
 *
 * CRITICAL MIDDLEWARE ORDER:
 *   1. express.raw() on webhook route BEFORE express.json() globally
 *      → the HMAC signature is computed over the raw body bytes
 *      → parsing as JSON first destroys the byte integrity
 *
 *   2. Helmet (security headers) before any routes
 *   3. CORS before routes
 *   4. requestLogger before routes
 *   5. express.json() for all non-webhook routes
 *   6. Routes
 *   7. errorHandler LAST (catches all next(err) calls)
 */
export function createApp(): Express {
  const app = express();

  // ── Security headers ─────────────────────────────────────────────────
  app.use(helmet());

  // ── CORS ─────────────────────────────────────────────────────────────
  app.use(cors({
    origin:      process.env.FRONTEND_URL ?? 'http://localhost:3000',
    credentials: true,
    methods:     ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // ── Request logging ───────────────────────────────────────────────────
  app.use(requestLogger);

  // ── CRITICAL: raw body for webhook route BEFORE express.json() ───────
  // Nomba HMAC is computed over the raw Buffer body.
  // If express.json() runs first, req.body becomes a parsed object
  // and the signature check will ALWAYS fail.
  app.use(
    '/api/v1/webhooks/nomba',
    express.raw({ type: 'application/json', limit: '1mb' }),
  );

  // ── JSON body parser for all other routes ────────────────────────────
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // ── Health check (public, no prefix) ─────────────────────────────────
  app.use('/health', healthRouter);

  // ── API v1 routes ─────────────────────────────────────────────────────
  const api = '/api/v1';

  // Auth (public)
  app.use(`${api}/auth`,         authRouter);

  // Org management (public POST for registration, admin PATCH)
  app.use(`${api}/orgs`,         orgRouter);

  // Public giving page — no auth
  app.use(`${api}/give`,         anonymousRouter);

  // Webhooks — public but HMAC verified (raw body applied above)
  app.use(`${api}/webhooks`,     webhookRouter);

  // Member portal
  app.use(`${api}`,              memberRouter);   // /me, /me/giving-history, /members
  app.use(`${api}`,              vaRouter);       // /me/funds/:fundId/account, /me/accounts

  // Admin modules (all require admin JWT)
  app.use(`${api}/orgs/:orgId/funds`, fundRouter);   // GET/POST funds for an org
  app.use(`${api}/funds`,             fundRouter);   // GET/PATCH/DELETE single fund
  app.use(`${api}/payouts`,           payoutRouter);
  app.use(`${api}/approve`,           approvalRouter);
  app.use(`${api}/signatories`,       signatoryRouter);
  app.use(`${api}/dashboard`,         dashboardRouter);
  app.use(`${api}`,                   reportRouter); // /orgs/:id/reports, /members/:id/statement
  app.use(`${api}/admin-users`,       adminUserRouter);
  app.use(`${api}/banks`,             bankRouter);

  // ── 404 handler ───────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  // ── Global error handler (MUST be last) ──────────────────────────────
  app.use(errorHandler);

  return app;
}