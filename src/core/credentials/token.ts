import { type ApiClient, ApiError } from '../http/client.js';

export type TokenKind = 'user' | 'account' | 'global_key' | 'unknown';

/** Cloudflare's "invalid API token" error code: what the user endpoint answers to an account-owned token. */
const INVALID_TOKEN_CODE = 1000;

const LEGACY_GLOBAL_KEY = /^[0-9a-f]{37}$/;

/**
 * Guesses the kind of a token from its prefix: `cfut_` is a user token, `cfat_` an account token, and `cfk_`
 * (or the 37-character hex string of the legacy format) a Global API Key. Anything else could be an older token
 * without a prefix, so it is `unknown` and `verifyToken` finds out.
 */
export function classifyToken(token: string): TokenKind {
  if (token.startsWith('cfut_')) return 'user';
  if (token.startsWith('cfat_')) return 'account';
  if (token.startsWith('cfk_') || LEGACY_GLOBAL_KEY.test(token)) return 'global_key';
  return 'unknown';
}

export interface TokenVerification {
  tokenType: 'user' | 'account';
  /** Cloudflare's own word for the state of the token: `active`, `disabled`, `expired`… */
  status: string;
  expiresOn?: string;
}

interface VerifyResult {
  status?: unknown;
  expires_on?: unknown;
}

async function verifyAs(
  client: ApiClient,
  path: string,
  tokenType: TokenVerification['tokenType'],
): Promise<TokenVerification> {
  const { result } = await client.request<VerifyResult | null>({ method: 'GET', path });
  const status = typeof result?.status === 'string' ? result.status : 'unknown';
  const expiresOn = typeof result?.expires_on === 'string' && result.expires_on !== '' ? result.expires_on : undefined;
  return { tokenType, status, ...(expiresOn === undefined ? {} : { expiresOn }) };
}

/**
 * Asks Cloudflare whether the token works, and what kind it is.
 *
 * - `user` → `GET /user/tokens/verify`; `account` → `GET /accounts/{acct}/tokens/verify`.
 * - `unknown` → the user endpoint first and, when it answers with error 1000 (invalid token, which is what an
 *   account-owned token gets there), the account endpoint. Any other error is final: it says nothing about the kind.
 *
 * It does not judge the status: the caller decides what to do with a token that is not `active`.
 */
export async function verifyToken(
  client: ApiClient,
  accountId: string,
  kind: Exclude<TokenKind, 'global_key'>,
): Promise<TokenVerification> {
  const userPath = '/user/tokens/verify';
  const accountPath = `/accounts/${encodeURIComponent(accountId)}/tokens/verify`;

  if (kind === 'user') return verifyAs(client, userPath, 'user');
  if (kind === 'account') return verifyAs(client, accountPath, 'account');

  try {
    return await verifyAs(client, userPath, 'user');
  } catch (err) {
    if (err instanceof ApiError && err.cfErrors.some((e) => e.code === INVALID_TOKEN_CODE)) {
      return verifyAs(client, accountPath, 'account');
    }
    throw err;
  }
}
