import { queryOne } from '../db';

/**
 * slug.ts — URL-safe church slug generation.
 *
 * The slug is the public join code in the member invite link:
 *   owoore.ng/join/grace-bible-church
 *
 * Requirements:
 *   - lowercase, hyphens only (no spaces, no special chars)
 *   - unique across all organisations
 *   - derived from the church name so it's human-readable
 *   - short enough to fit in a WhatsApp message preview
 */

/**
 * toSlug — converts a church name to a URL-safe slug.
 *
 * Examples:
 *   'Grace Bible Church'             → 'grace-bible-church'
 *   'RCCG Victory Parish - Abuja'    → 'rccg-victory-parish-abuja'
 *   "Christ's Embassy (HQ)"         → 'christs-embassy-hq'
 */
export function toSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['']/g, '')           // remove apostrophes
    .replace(/[^a-z0-9\s-]/g, '')  // remove special chars except hyphens
    .replace(/\s+/g, '-')          // spaces → hyphens
    .replace(/-+/g, '-')           // collapse multiple hyphens
    .replace(/^-|-$/g, '')         // trim leading/trailing hyphens
    .slice(0, 60);                  // max 60 chars
}

/**
 * generateUniqueSlug — creates a slug from the org name and ensures
 * it's unique in the organisations table. Appends a numeric suffix
 * if the base slug is already taken.
 *
 * Examples:
 *   'Grace Bible Church' (first)  → 'grace-bible-church'
 *   'Grace Bible Church' (second) → 'grace-bible-church-2'
 *   'Grace Bible Church' (third)  → 'grace-bible-church-3'
 */
export async function generateUniqueSlug(orgName: string): Promise<string> {
  const base = toSlug(orgName);

  // Check if base slug is available
  const existing = await queryOne<{ slug: string }>(
    'SELECT slug FROM organisations WHERE slug = $1',
    [base],
  );

  if (!existing) return base;

  // Find the next available suffix
  let suffix = 2;
  while (suffix <= 999) {
    const candidate = `${base}-${suffix}`;
    const taken = await queryOne<{ slug: string }>(
      'SELECT slug FROM organisations WHERE slug = $1',
      [candidate],
    );
    if (!taken) return candidate;
    suffix++;
  }

  // Fallback: append random 4-char hex to guarantee uniqueness
  const random = Math.random().toString(16).slice(2, 6);
  return `${base}-${random}`;
}

/**
 * isValidSlug — validates that a slug string is well-formed.
 * Used to sanitise join link path params before DB lookup.
 */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 60;
}