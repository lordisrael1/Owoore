import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { AppError } from '../utils/AppError';

/**
 * validateRequest — Zod schema validation middleware factory.
 *
 * Validates req.body, req.params, or req.query against a Zod schema.
 * On failure, returns a structured 422 with all field errors listed.
 * On success, replaces the target with the parsed (and coerced) value.
 *
 * Usage:
 *   import { sendOtpSchema } from '../validators/auth.validator';
 *   router.post('/send-otp', validateRequest(sendOtpSchema), authController.sendOtp);
 *
 *   // Validate params
 *   router.get('/orgs/:orgId', validateRequest(orgParamsSchema, 'params'), ...);
 */
export function validateRequest(
  schema: ZodSchema,
  target: 'body' | 'params' | 'query' = 'body',
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      const errors = formatZodErrors(result.error);
      return next(
        new AppError(
          `Validation failed: ${errors[0]?.message ?? 'Invalid input'}`,
          422,
          true,
          'VALIDATION_ERROR',
        ),
      );
    }

    // Replace with parsed value — Zod coercion applied (e.g. string → number)
    (req as any)[target] = result.data;
    next();
  };
}

/**
 * formatZodErrors — flattens ZodError into a simple array for API responses.
 */
function formatZodErrors(error: ZodError): Array<{ field: string; message: string }> {
  return error.issues.map((e) => ({
    field:   e.path.join('.') || 'root',
    message: e.message,
  }));
}

/**
 * validateBody / validateParams / validateQuery — convenience shorthands.
 */
export const validateBody   = (schema: ZodSchema) => validateRequest(schema, 'body');
export const validateParams = (schema: ZodSchema) => validateRequest(schema, 'params');
export const validateQuery  = (schema: ZodSchema) => validateRequest(schema, 'query');