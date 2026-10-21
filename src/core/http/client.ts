import { CliError, type CliErrorOptions, type ErrorCode } from '../errors.js';

export const API_BASE = 'https://api.cloudflare.com/client/v4';
export const API_TOKENS_URL = 'https://dash.cloudflare.com/profile/api-tokens';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
/** A 429 asking for a longer wait than this is reported instead of waited for. */
const MAX_RETRY_AFTER_SECONDS = 10;
/** Used when a 429 carries no usable `retry-after`. */
const DEFAULT_RETRY_AFTER_SECONDS = 1;

/** Printable ASCII without spaces: what a Cloudflare token is made of. */
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;

const APPLIED_HINT =
  'The request may or may not have been applied. Check with `cf-pages deployments list <project>` before retrying.';
const PERMISSION_HINT = `The API token needs the "Cloudflare Pages: Edit" permission (Read for read-only commands) on this account. Manage tokens: ${API_TOKENS_URL}`;

export interface CfError {
  code: number;
  message: string;
}

export interface ResultInfo {
  page: number;
  per_page: number;
  count: number;
  total_count: number;
  total_pages: number;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Relative to `API_BASE`, starting with `/`. Dynamic segments must already be passed through `encodeURIComponent`. */
  path: string;
  /** Entries whose value is `undefined` are left out. */
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  /** Sent as multipart/form-data. Values go out verbatim, never percent-encoded. */
  form?: Record<string, string>;
}

export interface ApiErrorOptions extends CliErrorOptions {
  /** HTTP status, or 0 when no response arrived (network failure, timeout). */
  status: number;
  cfErrors?: CfError[];
}

/** A failed Cloudflare API call. `cfErrors` holds the `errors` of the response envelope, empty when it had none. */
export class ApiError extends CliError {
  readonly status: number;
  readonly cfErrors: CfError[];

  constructor(code: ErrorCode, message: string, opts: ApiErrorOptions) {
    const { status, cfErrors = [], details, ...rest } = opts;
    super(code, message, {
      ...rest,
      details: { status, ...(cfErrors.length > 0 ? { cfErrors } : {}), ...details },
    });
    this.name = 'ApiError';
    this.status = status;
    this.cfErrors = cfErrors;
  }
}

export interface ApiClientOptions {
  token: string;
  userAgent: string;
  sleep: (ms: number) => Promise<void>;
  /** Receives one line per HTTP attempt: method, path, status and duration. Never headers or bodies. */
  debug?: (line: string) => void;
  timeoutMs?: number;
  /** How many times a request may be repeated after the first attempt. */
  maxRetries?: number;
}

type Outcome =
  | { kind: 'response'; status: number; retryAfter: string | null; text: string }
  | { kind: 'transport'; timedOut: boolean; cause: unknown };

type Envelope = Record<string, unknown>;

function parseEnvelope(text: string): Envelope | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Envelope) : undefined;
  } catch {
    return undefined;
  }
}

function readCfErrors(envelope: Envelope | undefined): CfError[] {
  const errors = envelope?.errors;
  if (!Array.isArray(errors)) return [];
  const out: CfError[] = [];
  for (const entry of errors as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { code, message } = entry as Record<string, unknown>;
    out.push({
      code: typeof code === 'number' ? code : Number(code) || 0,
      message: typeof message === 'string' ? message : '',
    });
  }
  return out;
}

function formatCfErrors(cfErrors: CfError[]): string {
  return cfErrors.map((e) => (e.message ? `[${e.code}] ${e.message}` : `[${e.code}]`)).join('; ');
}

function withDetail(lead: string, cfErrors: CfError[]): string {
  const detail = formatCfErrors(cfErrors);
  return detail ? `${lead}: ${detail}` : lead;
}

/** Seconds to wait according to `retry-after`; a missing or unusable header counts as one second. */
function retryAfterSeconds(header: string | null): number {
  const seconds = header === null || header.trim() === '' ? Number.NaN : Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : DEFAULT_RETRY_AFTER_SECONDS;
}

function transportReason(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = (cause.cause as { code?: unknown } | undefined)?.code;
    return typeof inner === 'string' ? inner : cause.message;
  }
  return String(cause);
}

/**
 * The only way the CLI talks to Cloudflare: bearer auth, a timeout per attempt, retries that never duplicate a
 * mutation, and failures mapped to `ApiError`s whose codes decide the exit code.
 *
 * Retry rules:
 * - GET is repeated on 5xx, network errors and timeouts, with exponential backoff.
 * - Any method is repeated on a 429 whose `retry-after` is at most 10 seconds, because a 429 means the request was
 *   rejected before it did anything.
 * - POST, PATCH and DELETE are never repeated after a 5xx, network error or timeout: the first attempt may have been
 *   applied. They fail with `api_error` and a hint to check the current state first.
 */
export class ApiClient {
  readonly #token: string;
  readonly #userAgent: string;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #debug: ((line: string) => void) | undefined;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;

  constructor(opts: ApiClientOptions) {
    // `fetch` rejects a header value with other characters and its message quotes the value, token included.
    if (!HEADER_SAFE_TOKEN.test(opts.token)) {
      throw new CliError('auth_invalid', 'The API token contains characters that cannot be sent in an HTTP header.', {
        hint: `Copy the token again without spaces or line breaks, then run \`cf-pages login\`. Manage tokens: ${API_TOKENS_URL}`,
      });
    }
    this.#token = opts.token;
    this.#userAgent = opts.userAgent;
    this.#sleep = opts.sleep;
    this.#debug = opts.debug;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async request<T>(o: RequestOptions): Promise<{ result: T; resultInfo?: ResultInfo }> {
    if (o.json !== undefined && o.form !== undefined)
      throw new Error('A request cannot have both a json and a form body.');
    const path = o.path.startsWith('/') ? o.path : `/${o.path}`;
    const search = this.#search(o.query);
    const readOnly = o.method === 'GET';
    const line = `${o.method} ${path}`;

    for (let attempt = 0; ; attempt++) {
      const outcome = await this.#send(o, path, search);

      if (outcome.kind === 'transport') {
        if (readOnly && attempt < this.#maxRetries) {
          await this.#sleep(BACKOFF_BASE_MS * 2 ** attempt);
          continue;
        }
        throw this.#transportError(line, outcome, readOnly);
      }

      const { status, text } = outcome;

      if (status === 429) {
        const wait = retryAfterSeconds(outcome.retryAfter);
        const cfErrors = readCfErrors(parseEnvelope(text));
        if (wait > MAX_RETRY_AFTER_SECONDS) {
          throw new ApiError(
            'rate_limited',
            withDetail(`Cloudflare rate limit reached (HTTP 429) and it asks to wait ${wait} seconds`, cfErrors),
            {
              status,
              cfErrors,
              hint: `Wait about ${wait} seconds and run the command again.`,
              details: { retryAfterSeconds: wait },
            },
          );
        }
        if (attempt < this.#maxRetries) {
          await this.#sleep(wait * 1000);
          continue;
        }
        throw new ApiError(
          'rate_limited',
          withDetail(
            `Cloudflare rate limit reached (HTTP 429) and ${this.#maxRetries} retries did not clear it`,
            cfErrors,
          ),
          { status, cfErrors, hint: 'Wait a minute and run the command again.', details: { retryAfterSeconds: wait } },
        );
      }

      if (status >= 500) {
        if (readOnly && attempt < this.#maxRetries) {
          await this.#sleep(BACKOFF_BASE_MS * 2 ** attempt);
          continue;
        }
        const cfErrors = readCfErrors(parseEnvelope(text));
        throw new ApiError('api_error', withDetail(`Cloudflare API returned HTTP ${status} for ${line}`, cfErrors), {
          status,
          cfErrors,
          hint: readOnly ? 'Cloudflare may be having trouble. Wait a moment and run the command again.' : APPLIED_HINT,
        });
      }

      return this.#settle<T>(o, line, status, text);
    }
  }

  #search(query: RequestOptions['query']): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.append(key, String(value));
    }
    const text = params.toString();
    return text === '' ? '' : `?${text}`;
  }

  /** One HTTP attempt. Resolves with what arrived, or with `transport` when nothing usable did. Never throws. */
  async #send(o: RequestOptions, path: string, search: string): Promise<Outcome> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#token}`,
      'user-agent': this.#userAgent,
      accept: 'application/json',
    };
    let body: string | FormData | undefined;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers['content-type'] = 'application/json';
    } else if (o.form !== undefined) {
      // `fetch` adds the multipart content type with its boundary.
      body = new FormData();
      for (const [key, value] of Object.entries(o.form)) body.append(key, value);
    }

    const signal = AbortSignal.timeout(this.#timeoutMs);
    const started = performance.now();
    const log = (what: string | number) =>
      this.#debug?.(`${o.method} ${path}${search} ${what} ${Math.round(performance.now() - started)}ms`);
    try {
      // The signal also covers reading the body, so a stalled response cannot hang the command.
      // Redirects are refused: the API does not use them, and the token must never follow one to another host.
      const response = await fetch(`${API_BASE}${path}${search}`, {
        method: o.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal,
        redirect: 'error',
      });
      const text = await response.text();
      log(response.status);
      return { kind: 'response', status: response.status, retryAfter: response.headers.get('retry-after'), text };
    } catch (cause) {
      const timedOut = signal.aborted;
      log(timedOut ? 'timeout' : 'error');
      return { kind: 'transport', timedOut, cause };
    }
  }

  #transportError(line: string, outcome: Extract<Outcome, { kind: 'transport' }>, readOnly: boolean): ApiError {
    const message = outcome.timedOut
      ? `${line} timed out after ${this.#timeoutMs / 1000}s.`
      : `Could not reach the Cloudflare API (${line}): ${transportReason(outcome.cause)}.`;
    const retryHint = outcome.timedOut
      ? 'The API did not answer in time. Check your network connection and run the command again.'
      : 'Check your network connection and run the command again.';
    return new ApiError('api_error', message, {
      status: 0,
      hint: readOnly ? retryHint : APPLIED_HINT,
      cause: outcome.cause,
    });
  }

  /** Turns a final (non-5xx, non-429) response into a result or the matching error. */
  #settle<T>(o: RequestOptions, line: string, status: number, text: string): { result: T; resultInfo?: ResultInfo } {
    const envelope = parseEnvelope(text);
    const cfErrors = readCfErrors(envelope);
    const mutation = o.method !== 'GET';

    if (status >= 200 && status < 300) {
      if (envelope === undefined) {
        throw new ApiError(
          'api_error',
          `Cloudflare API returned an unreadable response (HTTP ${status}) for ${line}.`,
          {
            status,
            hint: mutation ? APPLIED_HINT : 'Run the command again. If it keeps happening, run it with --debug.',
          },
        );
      }
      if (envelope.success !== true) {
        throw new ApiError('api_error', formatCfErrors(cfErrors) || `Cloudflare reported a failure for ${line}.`, {
          status,
          cfErrors,
          hint: 'Check the command arguments and run it again. Use --debug to see the request line.',
        });
      }
      const info = envelope.result_info;
      return {
        result: envelope.result as T,
        ...(typeof info === 'object' && info !== null ? { resultInfo: info as ResultInfo } : {}),
      };
    }

    switch (status) {
      case 401:
        throw new ApiError('auth_invalid', withDetail('Cloudflare rejected the API token (HTTP 401)', cfErrors), {
          status,
          cfErrors,
          hint: `Check that the token is valid, not expired and not revoked, then run \`cf-pages login\` again. Manage tokens: ${API_TOKENS_URL}`,
        });
      case 403:
        throw new ApiError(
          'permission_denied',
          withDetail('The API token is not allowed to do this (HTTP 403)', cfErrors),
          {
            status,
            cfErrors,
            hint: PERMISSION_HINT,
          },
        );
      case 404:
        throw new ApiError(
          'not_found',
          withDetail(`Cloudflare could not find the resource (HTTP 404) for ${line}`, cfErrors),
          {
            status,
            cfErrors,
            hint: 'Check the project, deployment and account, then try again.',
          },
        );
      default:
        throw new ApiError('api_error', withDetail(`Cloudflare API returned HTTP ${status} for ${line}`, cfErrors), {
          status,
          cfErrors,
          hint: 'Check the command arguments and run it again. Use --debug to see the request line.',
        });
    }
  }
}
