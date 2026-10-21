export type ErrorCode =
  | 'usage'
  | 'auth_required'
  | 'auth_invalid'
  | 'permission_denied'
  | 'keyring_unavailable'
  | 'not_found'
  | 'confirmation_required'
  | 'cancelled'
  | 'api_error'
  | 'rate_limited'
  | 'verification_failed'
  | 'deployment_failed'
  | 'unexpected';

export const EXIT_CODES: Record<ErrorCode, number> = {
  usage: 2,
  auth_required: 3,
  auth_invalid: 3,
  permission_denied: 3,
  keyring_unavailable: 3,
  not_found: 4,
  confirmation_required: 5,
  cancelled: 5,
  api_error: 6,
  rate_limited: 6,
  verification_failed: 6,
  deployment_failed: 7,
  unexpected: 1,
};

export interface CliErrorOptions {
  /** What to try next. */
  hint?: string;
  /** Machine-readable context, included in the `--json` error document. Must not contain secrets. */
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** An error the CLI knows how to report: a stable `code`, an exit code and an optional hint. */
export class CliError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts: CliErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'CliError';
    this.code = code;
    if (opts.hint !== undefined) this.hint = opts.hint;
    if (opts.details !== undefined) this.details = opts.details;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}
