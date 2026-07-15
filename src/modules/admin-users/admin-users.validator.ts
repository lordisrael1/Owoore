import { z } from 'zod';
import { safeText } from '../../utils/sanitize';

export const inviteSchema = z.object({
  email: z.string().email('A valid email address is required'),
  name:  safeText(z.string().min(2, 'Name must be at least 2 characters').max(255)),
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

export const adminUserIdParamSchema = z.object({
  id: z.string().uuid('Invalid team member id'),
});

export const updateAdminUserSchema = z.object({
  is_active: z.boolean(),
});

export type InviteInput       = z.infer<typeof inviteSchema>;
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
