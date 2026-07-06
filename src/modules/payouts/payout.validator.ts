import { z } from 'zod';
import { safeText } from '../../utils/sanitize';

/**
 * payout.validator.ts — Zod schemas for payout request endpoints.
 */

export const initPayoutSchema = z.object({
  fund_type_id:     z.string().uuid('fund_type_id must be a valid UUID'),
  bank_code:        z.string().min(1, 'bank_code is required'),
  account_number:   z.string().regex(/^\d{10}$/, 'account_number must be a 10-digit account number'),
  amount:           z.number({ error: 'amount is required' })
                     .positive('amount must be greater than zero')
                     .max(100_000_000, 'amount cannot exceed ₦1,000,000 per request'),
  purpose:          safeText(z.string()
                     .min(5,   'purpose must be at least 5 characters')
                     .max(500, 'purpose cannot exceed 500 characters')),
});

export const payoutParamsSchema = z.object({
  id: z.string().uuid('Payout ID must be a valid UUID'),
});

export const payoutListQuerySchema = z.object({
  status:  z.enum(['PENDING','PARTIAL','APPROVED','TRANSFERRING',
                   'TRANSFERRED','DECLINED','EXPIRED','FAILED','CANCELLED'])
             .optional(),
  limit:   z.string().optional().transform(v => v ? Number(v) : 20),
  offset:  z.string().optional().transform(v => v ? Number(v) : 0),
});

export type InitPayoutInput = z.infer<typeof initPayoutSchema>;