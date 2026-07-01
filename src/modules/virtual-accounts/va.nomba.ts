import { nombaClient } from '../../config/nomba';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { Errors } from '../../utils/AppError';
import { assertKobo } from '../../utils/kobo';

/**
 * va.nomba.ts
 *
 * Thin wrapper around Nomba's Virtual Account API.
 * POST /accounts/virtual/{subAccountId} — sub-account-scoped creation.
 * This guarantees inflows settle into our shared sub-account balance
 * (NOMBA_SUB_ACCOUNT_ID), not the parent merchant account.
 *
 * Only this file calls the Nomba VA endpoint — all VA creation
 * goes through here so the API contract is in one place.
 *
 * Response shape:
 *   { code: "00", data: { id, accountNumber, bankName, ... } }
 *
 * accountRef is our stable key: member_{memberId}_fund_{fundTypeId}
 * This is what comes back in every inbound webhook payload —
 * one lookup in member_fund_accounts resolves the entire context.
 *
 * For CAMPAIGN funds: pass expiryDate from fund_type.expires_at
 * For RECURRING funds: omit expiryDate → permanent VA
 *
 * For funds with expected_amt_kobo: pass amount → Nomba sets expectedAmount
 * Bank rails will still accept any value — we reconcile in our webhook handler.
 */

export interface CreateVAInput {
  accountRef:    string;   // member_{memberId}_fund_{fundTypeId}
  accountName:   string;   // "Bro Adebayo — Tithe — Grace Bible Church"
  expiryDate?:   string;   // ISO date string — CAMPAIGN funds only
  expectedKobo?: number;   // optional pledge amount in kobo
}

export interface NombaVAResult {
  nombaVaId:     string;
  vaNumber:      string;   // the NUBAN the member copies into their bank app
  bankName:      string;
  accountRef:    string;
}

export const vaNomba = {
  /**
   * create — POST /accounts/virtual/{subAccountId}
   *
   * Creates a dedicated NUBAN account scoped to our shared sub-account.
   * When the member transfers to this NUBAN from any Nigerian bank,
   * Nomba fires a virtual_account.funded webhook, and the funds land
   * in our sub-account balance (not the parent).
   */
  async create(input: CreateVAInput): Promise<NombaVAResult> {
    const { accountRef, accountName, expiryDate, expectedKobo } = input;

    // Validate kobo amount if provided
    if (expectedKobo !== undefined) {
      assertKobo(expectedKobo, 'expectedAmount for VA');
    }

    const payload: Record<string, unknown> = {
      accountRef,
      // Nomba rejects special characters — strip to alphanumeric + spaces only
      accountName: accountName
        .replace(/[^a-zA-Z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 64),
    };

    if (expiryDate) {
      payload.expiryDate = expiryDate;
    }

    if (expectedKobo && expectedKobo > 0) {
      payload.expectedAmount = expectedKobo / 100; // Nomba expects naira (float), not kobo
    }

    logger.info({
      account_ref:  accountRef,
      account_name: payload.accountName,
      payload,
    }, '[VaNomba] Creating virtual account — POST /accounts/virtual');

    try {
      const response = await nombaClient.post(
        `/accounts/virtual/${env.NOMBA_SUB_ACCOUNT_ID}`,
        payload,
        { headers: { accountId: env.NOMBA_ACCOUNT_ID } },
      );

      const { code, data, description } = response.data;

      if (code !== '00') {
        logger.error({ code, description, full_response: response.data }, '[VaNomba] Nomba non-success response');
        throw new Error(
          `Nomba VA creation failed: ${description ?? 'Unknown error'} (code: ${code})`,
        );
      }

      const result: NombaVAResult = {
        nombaVaId:  data.accountHolderId,
        vaNumber:   data.bankAccountNumber,
        bankName:   data.bankName ?? 'Providus Bank',
        accountRef,
      };

      logger.info({
        account_ref: accountRef,
        va_number:   result.vaNumber,
        bank:        result.bankName,
        nomba_va_id: result.nombaVaId,
      }, '[VaNomba] Virtual account created successfully');

      return result;

    } catch (err: any) {
      const msg = err.response?.data?.description ?? err.message;

      logger.error({
        account_ref: accountRef,
        nomba_status: err.response?.status,
        nomba_full_response: err.response?.data,
      }, '[VaNomba] Full Nomba error response');

      // Nomba already has this accountRef (e.g. a prior call succeeded on their
      // side but our DB write failed afterward) — recover instead of failing.
      if (msg?.includes('already exists')) {
        logger.warn({ account_ref: accountRef },
          '[VaNomba] VA already exists on Nomba — fetching existing details');
        return this.getByAccountRef(accountRef);
      }

      logger.error({ account_ref: accountRef, err: msg },
        '[VaNomba] VA creation request failed');

      throw Errors.nombaError(`Virtual account creation failed: ${msg}`);
    }
  },

  /**
   * getByAccountRef — GET /accounts/virtual/{identifier}
   * Fetches an existing VA using our own accountRef as the identifier.
   * Used to recover when Nomba reports an accountRef as already existing.
   */
  async getByAccountRef(accountRef: string): Promise<NombaVAResult> {
    try {
      const response = await nombaClient.get(
        `/accounts/virtual/${accountRef}`,
        { headers: { accountId: env.NOMBA_ACCOUNT_ID } },
      );

      const { code, data, description } = response.data;
      if (code !== '00') {
        throw new Error(`Nomba returned code: ${code} — ${description ?? 'Unknown error'}`);
      }

      return {
        nombaVaId:  data.accountHolderId,
        vaNumber:   data.bankAccountNumber,
        bankName:   data.bankName ?? 'Providus Bank',
        accountRef,
      };
    } catch (err: any) {
      const msg = err.response?.data?.description ?? err.message;
      logger.error({ account_ref: accountRef, err: msg },
        '[VaNomba] Get VA by accountRef failed');
      throw Errors.nombaError(`Could not fetch existing virtual account: ${msg}`);
    }
  },

  /**
   * expire — DELETE /accounts/virtual/{identifier}
   * Expires a VA using our own accountRef as the identifier.
   */
  async expire(accountRef: string): Promise<boolean> {
    try {
      const response = await nombaClient.delete(
        `/accounts/virtual/${accountRef}`,
        { headers: { accountId: env.NOMBA_ACCOUNT_ID } },
      );

      const { code, data, description } = response.data;
      if (code !== '00') {
        throw new Error(`Nomba returned code: ${code} — ${description ?? 'Unknown error'}`);
      }

      logger.info({ account_ref: accountRef, expired: data.expired },
        '[VaNomba] Virtual account expired');

      return !!data.expired;
    } catch (err: any) {
      const msg = err.response?.data?.description ?? err.message;
      logger.error({ account_ref: accountRef, err: msg },
        '[VaNomba] Expire VA failed');
      throw Errors.nombaError(`Could not expire virtual account: ${msg}`);
    }
  },
};