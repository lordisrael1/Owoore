import DOMPurify from 'isomorphic-dompurify';
import { z } from 'zod';

/**
 * sanitize.ts — strips HTML/script from user-supplied free text.
 *
 * WHY: SQL injection is already covered — every query in the codebase is
 * parameterised ($1, $2, ...). What parameterisation does NOT stop is
 * STORED XSS: a member named `<script>...</script>` is written to the DB
 * verbatim and later interpolated into HTML emails (payment confirmations,
 * approval requests) and any future dashboard UI. So we strip markup at
 * the door, before it ever reaches the database.
 *
 * ONLY for human-authored display text (names, descriptions, purpose,
 * narration). Never for structured values — emails, slugs, UUIDs, bank
 * codes, phone numbers — those are pinned down by their own validators
 * and sanitising them would only mask bad input that should be rejected.
 */

/** Strips ALL HTML tags/attributes and trims. */
export function sanitizeText(input: string): string {
  return DOMPurify.sanitize(input, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }).trim();
}

/**
 * safeText — zod pipeline for free-text fields: validate length first
 * (so error messages reflect what the user actually typed), then strip
 * markup. Compose extra checks on the base schema you pass in:
 *
 *   name: safeText(z.string().min(3, 'Too short').max(255))
 */
export function safeText<S extends z.ZodString>(schema: S) {
  return schema.transform(sanitizeText);
}
