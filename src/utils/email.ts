/**
 * normaliseEmail — lowercases and trims for consistent lookup/storage.
 * Format validation is handled by zod (.email()) at the request boundary.
 */
export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * maskEmail — for logs: j***@gmail.com
 */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}
