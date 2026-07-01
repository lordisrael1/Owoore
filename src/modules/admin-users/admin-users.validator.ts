import { z } from 'zod';

export const inviteSchema = z.object({
  email: z.string().email('A valid email address is required'),
  name:  z.string().min(2, 'Name must be at least 2 characters').max(255),
  role:  z.enum(['TREASURER', 'ADMIN']).default('TREASURER'),
});

export const acceptInviteSchema = z.object({
  token:    z.string().uuid('Invalid invite token'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const setPasswordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const inviteTokenParamSchema = z.object({
  token: z.string().uuid('Invalid invite token'),
});

export type InviteInput       = z.infer<typeof inviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
