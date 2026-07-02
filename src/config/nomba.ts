import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { env } from './env';

// ── Token cache ────────────────────────────────────────────────────────────
// Nomba tokens are valid for 60 minutes.
// We cache the token in memory and refresh at the 55-minute mark
// so we never make a fresh auth call on every API request.
interface TokenCache {
  accessToken: string;
  expiresAt: number; // unix ms
}

let tokenCache: TokenCache | null = null;

/**
 * fetchNombaToken — exchanges client_id + client_secret for a Bearer token.
 * Called once on startup and then automatically at the 55-min mark.
 */
async function fetchNombaToken(): Promise<string> {
  const res = await axios.post(
    `${env.NOMBA_BASE_URL}/v1/auth/token/issue`,
    {
      grant_type: 'client_credentials',
      client_id: env.NOMBA_CLIENT_ID,
      client_secret: env.NOMBA_CLIENT_SECRET,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        accountId: env.NOMBA_ACCOUNT_ID,
      },
    },
  );

  const { access_token, expires_in } = res.data.data;

  // Cache: expire 5 minutes early (55-min buffer)
  tokenCache = {
    accessToken: access_token,
    expiresAt: Date.now() + (expires_in - 300) * 1000,
  };

  console.log('[Nomba] Access token refreshed');
  return access_token;
}

/**
 * getValidToken — returns a valid cached token or fetches a fresh one.
 */
async function getValidToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  return fetchNombaToken();
}

// ── Axios instances ────────────────────────────────────────────────────────
// Nomba mixes API versions across endpoints — most sit under /v1, but the
// sub-account transfer endpoint is /v2 directly off the root (NOT /v1/v2).
// Two clients, same auth/logging behaviour, different base paths.
function createNombaClient(baseURL: string): AxiosInstance {
  const client = axios.create({
    baseURL,
    headers: {
      'Content-Type': 'application/json',
      accountId: env.NOMBA_ACCOUNT_ID,
    },
    timeout: 30000, // 30s — Nomba transfers may be slow
  });

  // Request interceptor — inject Bearer token on every call
  client.interceptors.request.use(
    async (config: InternalAxiosRequestConfig) => {
      const token = await getValidToken();
      config.headers.Authorization = `Bearer ${token}`;
      return config;
    },
    (error) => Promise.reject(error),
  );

  // Response interceptor — log Nomba errors with full context
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      const nombaError = error.response?.data;
      console.error('[Nomba] API error', {
        status: error.response?.status,
        url: error.config?.url,
        nombaCode: nombaError?.code,
        nombaMessage: nombaError?.message,
      });
      return Promise.reject(error);
    },
  );

  return client;
}

export const nombaClient: AxiosInstance   = createNombaClient(`${env.NOMBA_BASE_URL}/v1`);
export const nombaClientV2: AxiosInstance = createNombaClient(env.NOMBA_BASE_URL);

/**
 * initNomba — fetch the first token at startup so the first real
 * API call doesn't pay the auth latency penalty.
 */
export async function initNomba(): Promise<void> {
  try {
    await fetchNombaToken();
    console.log('[Nomba] Client initialised — sandbox:', env.NOMBA_BASE_URL.includes('sandbox'));
  } catch (err) {
    console.error('[Nomba] Failed to fetch initial token:', err);
    process.exit(1);
  }
}

// Convenience sub-account header — use when scoping calls to the sub-account
export const subAccountHeader = { accountId: env.NOMBA_SUB_ACCOUNT_ID };