import { z } from 'zod';
import { safeText } from '../../utils/sanitize';

export const createFundSchema = z.object({
  name: safeText(z.string().min(2, 'Fund name must be at least 2 characters').max(255)),
  kind: z.enum(['RECURRING', 'CAMPAIGN']).default('RECURRING'),
  description:       safeText(z.string().max(500)).optional(),
  expected_amt:      z.number().positive('Expected amount must be positive').optional(),
  expires_at:        z.string().datetime().optional(),
}).refine(
  (data) => !(data.kind === 'CAMPAIGN' && !data.expires_at),
  { message: 'CAMPAIGN funds must have an expires_at date', path: ['expires_at'] },
);

export const updateFundSchema = z.object({
  name:         safeText(z.string().min(2).max(255)).optional(),
  description:  safeText(z.string().max(500)).optional(),
  expected_amt: z.number().positive().optional(),
  expires_at:   z.string().datetime().optional(),
  sort_order:   z.number().int().min(0).optional(),
  is_active:    z.boolean().optional(),
  is_shared_va: z.boolean().optional(),
});

export const fundParamsSchema = z.object({
  id: z.string().uuid('Fund type ID must be a valid UUID'),
});

export const orgFundParamsSchema = z.object({
  orgId: z.string().uuid(),
});

export type CreateFundInput = z.infer<typeof createFundSchema>;
export type UpdateFundInput = z.infer<typeof updateFundSchema>;