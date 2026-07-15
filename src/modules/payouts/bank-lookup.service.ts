import { nombaClient } from '../../config/nomba';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { AppError, Errors } from '../../utils/AppError';
import axios from 'axios';

// ── Types ─────────────────────────────────────────────────────────────────

export interface NombaBank {
  code: string;  // e.g. "058"
  name: string;  // e.g. "Guaranty Trust Bank"
}

export interface BankAccountLookupResult {
  accountNumber: string;
  accountName:   string;
  bankCode:      string;
  bankName:      string;
}

// ── In-memory bank list cache ─────────────────────────────────────────────
// Nomba docs: "Call this endpoint once and cache the result — bank codes rarely change."
// GET /v1/transfers/banks

interface BankCache {
  banks:     NombaBank[];
  fetchedAt: number; // unix ms
}

let bankCache: BankCache | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const BANK_LIST_MAX_ATTEMPTS = 3;

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A bank-list read is safe to retry when the upstream closes the connection
 * mid-response. Do not retry business/API errors, which need operator action.
 */
function isRetryableBankListError(err: unknown): boolean {
  if (!axios.isAxiosError(err)) return false;

  return [
    'ECONNABORTED',
    'ECONNRESET',
    'ERR_CANCELED',
    'ERR_NETWORK',
    'ERR_BAD_RESPONSE',
  ].includes(err.code ?? '') || /\baborted\b/i.test(err.message);
}

// ── Bank list ─────────────────────────────────────────────────────────────

/**
 * getAllBanks — GET /v1/transfers/banks
 *
 * Fetches all supported Nigerian banks from Nomba.
 * Cached in memory for 24 hours — bank codes rarely change.
 * Falls back to stale cache if Nomba is temporarily unreachable.
 *
 * Response shape:
 *   { code: "00", description: "...", data: { results: [{ code, name }] } }
 */
export async function getAllBanks(): Promise<NombaBank[]> {
  // Return fresh cache
  if (bankCache && Date.now() - bankCache.fetchedAt < CACHE_TTL_MS) {
    return bankCache.banks;
  }

  logger.info('[BankLookup] Fetching bank list from Nomba GET /v1/transfers/banks');

  try {
    let response;
    for (let attempt = 1; attempt <= BANK_LIST_MAX_ATTEMPTS; attempt += 1) {
      try {
        response = await nombaClient.get('/transfers/banks', {
          headers: { accountId: env.NOMBA_ACCOUNT_ID },
        });
        break;
      } catch (err) {
        if (!isRetryableBankListError(err) || attempt === BANK_LIST_MAX_ATTEMPTS) {
          throw err;
        }

        const delayMs = attempt * 1_000;
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({
          attempt,
          maxAttempts: BANK_LIST_MAX_ATTEMPTS,
          delayMs,
          err: message,
          code: axios.isAxiosError(err) ? err.code : undefined,
          status: axios.isAxiosError(err) ? err.response?.status : undefined,
        }, '[BankLookup] Bank-list request interrupted; retrying');
        await wait(delayMs);
      }
    }

    // The loop either returned a response or threw its final error.
    if (!response) throw new Error('Nomba bank-list request returned no response');

    const { code, data } = response.data;

    if (code !== '00') {
      throw new Error(`Nomba returned non-success code: ${code} — ${response.data.description}`);
    }

    const rawList: any[] = Array.isArray(data) ? data : (data?.results ?? []);

    const banks: NombaBank[] = rawList.map((b: any) => ({
      code: String(b.code),
      name: String(b.name),
    }));

    if (banks.length === 0) {
      logger.warn('[BankLookup] Nomba returned an empty bank list');
      return bankCache?.banks ?? [];
    }

    bankCache = { banks, fetchedAt: Date.now() };
    logger.info(`[BankLookup] Cached ${banks.length} banks`);
    return banks;

  } catch (err: any) {
    logger.error({
      err: err.message,
      code: axios.isAxiosError(err) ? err.code : undefined,
      status: axios.isAxiosError(err) ? err.response?.status : undefined,
    }, '[BankLookup] Failed to fetch bank list');

    // Stale cache is better than crashing
    if (bankCache) {
      logger.warn('[BankLookup] Returning stale bank cache as fallback');
      return bankCache.banks;
    }

    throw Errors.nombaError('Could not fetch bank list. Please try again shortly.');
  }
}

/**
 * getBankCode — resolves a bank display name to its Nomba bank code.
 * Case-insensitive, partial match supported.
 */
export async function getBankCode(bankName: string): Promise<string | undefined> {
  const banks = await getAllBanks();
  const lower = bankName.toLowerCase().trim();
  const match = banks.find(
    (b) =>
      b.name.toLowerCase() === lower ||
      b.name.toLowerCase().includes(lower) ||
      lower.includes(b.name.toLowerCase()),
  );
  return match?.code;
}

/**
 * getBankName — resolves a bank code to its display name.
 */
export async function getBankName(code: string): Promise<string | undefined> {
  const banks = await getAllBanks();
  return banks.find((b) => b.code === code)?.name;
}

/**
 * bankDropdownOptions — sorted [{label, value}] list for UI dropdowns.
 */
export async function bankDropdownOptions(): Promise<Array<{ label: string; value: string }>> {
  const banks = await getAllBanks();
  return banks
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((b) => ({ label: b.name, value: b.code }));
}

// ── Bank account lookup ───────────────────────────────────────────────────

/**
 * lookupBankAccount — POST /v1/transfers/bank/lookup
 *
 * Verifies a NUBAN account number and returns the account holder's name.
 *
 * Nomba docs:
 *   "Always verify a recipient account before initiating a transfer.
 *    This confirms the account exists and returns the account holder's
 *    name — which you should display to your user for confirmation
 *    before sending funds."
 *
 * Nomba checklist:
 *   "Recipient name verified via /transfers/bank/lookup before transfers"
 *
 * Response shape:
 *   { code: "00", data: { accountNumber, accountName } }
 *   code "00" = valid account found
 *
 * @throws AppError 422 if account not found or bank code invalid
 * @throws AppError 502 if Nomba is unreachable
 */
export async function lookupBankAccount(
  bankCode: string,
  accountNumber: string,
): Promise<BankAccountLookupResult> {
  // Mask account number in logs — only show last 4 digits
  const maskedAcct = accountNumber.slice(-4).padStart(accountNumber.length, '*');

  logger.info({
    bank_code:  bankCode,
    account:    maskedAcct,
  }, '[BankLookup] Verifying account — POST /v1/transfers/bank/lookup');

  try {
    const response = await nombaClient.post(
      '/transfers/bank/lookup',
      { accountNumber, bankCode },
      { headers: { accountId: env.NOMBA_ACCOUNT_ID } },
    );

    const { code, data, description } = response.data;

    if (code !== '00') {
      throw new AppError(
        `Bank account lookup failed: ${description ?? 'Account not found'}`,
        422,
        true,
        'BANK_LOOKUP_FAILED',
      );
    }

    const bankName = (await getBankName(bankCode)) ?? bankCode;

    const result: BankAccountLookupResult = {
      accountNumber: data.accountNumber,
      accountName:   data.accountName,
      bankCode,
      bankName,
    };

    logger.info({
      account_name: result.accountName,
      bank:         result.bankName,
      account:      maskedAcct,
    }, '[BankLookup] Account verified successfully');

    return result;

  } catch (err: any) {
    if (err instanceof AppError) throw err;

    const nombaMsg = err.response?.data?.description ?? err.message;
    logger.error({ bank_code: bankCode, account: maskedAcct, err: nombaMsg },
      '[BankLookup] Lookup request failed');

    throw Errors.nombaError(`Bank account lookup failed: ${nombaMsg}`);
  }
}

/**
 * warmBankCache — pre-loads the bank list at startup.
 * Prevents the first payout from paying the fetch latency penalty.
 * Non-fatal: app continues even if Nomba is unreachable at startup.
 */
export async function warmBankCache(): Promise<void> {
  try {
    await getAllBanks();
    logger.info('[BankLookup] Bank cache warmed at startup');
  } catch {
    logger.warn('[BankLookup] Could not pre-warm bank cache — will fetch on first request');
  }
}
