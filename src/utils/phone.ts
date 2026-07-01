import { fromKobo } from './kobo';

/**
 * formatNaira — formats a KOBO integer as a ₦ display string.
 *
 * Examples:
 *   formatNaira(5_000_000)   → '₦50,000.00'
 *   formatNaira(150_000)     → '₦1,500.00'
 *   formatNaira(100)         → '₦1.00'
 *   formatNaira(50)          → '₦0.50'
 */
export function formatNaira(kobo: number): string {
  const naira = fromKobo(kobo);
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    currencyDisplay: 'symbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
    .format(naira)
    .replace('NGN', '₦')   // Intl sometimes outputs 'NGN' instead of '₦'
    .trim();
}

/**
 * formatNairaCompact — shorter format for SMS (160 char limit).
 *
 * Examples:
 *   formatNairaCompact(5_000_000)   → '₦50,000'
 *   formatNairaCompact(150_050)     → '₦1,500.50'
 */
export function formatNairaCompact(kobo: number): string {
  const naira = fromKobo(kobo);
  const hasDecimals = kobo % 100 !== 0;

  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    currencyDisplay: 'symbol',
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2,
  })
    .format(naira)
    .replace('NGN', '₦')
    .trim();
}

/**
 * formatPeriod — converts a YYYY-MM period string to a display label.
 *
 * Examples:
 *   formatPeriod('2026-06')  → 'June 2026'
 *   formatPeriod('2026-01')  → 'January 2026'
 */
export function formatPeriod(periodMonth: string): string {
  const [year, month] = periodMonth.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' });
}

/**
 * currentPeriod — returns the current YYYY-MM period string.
 * Used when writing transaction records.
 */
export function currentPeriod(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * formatVariance — shows surplus/deficit clearly for dashboard and emails.
 *
 * Examples:
 *   formatVariance(200_000)    → '+₦2,000.00 overpayment'
 *   formatVariance(-500_000)   → '-₦5,000.00 deficit'
 *   formatVariance(0)          → 'exact'
 */
export function formatVariance(varianceKobo: number): string {
  if (varianceKobo === 0) return 'exact';
  const prefix = varianceKobo > 0 ? '+' : '-';
  const label  = varianceKobo > 0 ? 'overpayment' : 'deficit';
  return `${prefix}${formatNaira(Math.abs(varianceKobo))} ${label}`;
}