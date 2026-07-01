import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * catchAsync — wraps an async Express controller so unhandled promise
 * rejections are forwarded to the global errorHandler middleware.
 *
 * Without this wrapper, an async controller that throws will cause an
 * unhandled promise rejection and hang the request indefinitely.
 *
 * Usage:
 *   router.post('/orgs', catchAsync(orgController.create));
 *
 * Instead of:
 *   router.post('/orgs', async (req, res, next) => {
 *     try { ... } catch (err) { next(err); }
 *   });
 */
export function catchAsync(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}