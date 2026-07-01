import { z } from 'zod';

export const memberJoinSchema = z.object({
  email:        z.string().email('Enter a valid email address'),
  display_name: z.string().min(1, 'Name is required').max(100),
});

export const memberParamsSchema = z.object({
  id: z.string().uuid('Member ID must be a valid UUID'),
});

export const givingHistoryQuerySchema = z.object({
  fund_type_id: z.string().uuid().optional(),
  period:       z.string().regex(/^\d{4}-\d{2}$/, 'Period must be YYYY-MM format').optional(),
  limit:        z.string().optional().transform(v => v ? Math.min(Number(v), 100) : 20),
  offset:       z.string().optional().transform(v => v ? Number(v) : 0),
});