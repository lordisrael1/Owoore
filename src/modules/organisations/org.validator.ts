import { z } from 'zod';
import { safeText } from '../../utils/sanitize';

export const createOrgSchema = z.object({
  name:          safeText(z.string().min(3, 'Church name must be at least 3 characters').max(255)),
  admin_name:    safeText(z.string().min(2, 'Admin name required').max(255)),
  admin_email:   z.string().email('Invalid email'),
  admin_password: z.string().min(8, 'Password must be at least 8 characters'),
});

export const updateOrgSchema = z.object({
  name: safeText(z.string().min(3).max(255)).optional(),
});

export const orgSlugParamSchema = z.object({
  slug: z.string().min(1),
});

export const orgIdParamSchema = z.object({
  id: z.string().uuid('Invalid org ID'),
});

export type CreateOrgInput  = z.infer<typeof createOrgSchema>;
export type UpdateOrgInput  = z.infer<typeof updateOrgSchema>;