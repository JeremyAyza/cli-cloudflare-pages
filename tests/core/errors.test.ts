import { describe, expect, it } from 'vitest';
import { CliError, type ErrorCode, EXIT_CODES } from '../../src/core/errors.js';

describe('EXIT_CODES', () => {
  it.each<[ErrorCode, number]>([
    ['usage', 2],
    ['auth_required', 3],
    ['auth_invalid', 3],
    ['permission_denied', 3],
    ['keyring_unavailable', 3],
    ['not_found', 4],
    ['confirmation_required', 5],
    ['cancelled', 5],
    ['api_error', 6],
    ['rate_limited', 6],
    ['verification_failed', 6],
    ['deployment_failed', 7],
    ['unexpected', 1],
  ])('%s → %i', (code, exitCode) => {
    expect(EXIT_CODES[code]).toBe(exitCode);
  });
});

describe('CliError', () => {
  it('carries code, hint, details and cause, and derives exitCode from the code', () => {
    const cause = new Error('socket hang up');
    const err = new CliError('api_error', 'Cloudflare is down.', {
      hint: 'Retry later.',
      details: { status: 502 },
      cause,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CliError');
    expect(err.message).toBe('Cloudflare is down.');
    expect(err.code).toBe('api_error');
    expect(err.hint).toBe('Retry later.');
    expect(err.details).toEqual({ status: 502 });
    expect(err.cause).toBe(cause);
    expect(err.exitCode).toBe(6);
  });

  it('options are optional', () => {
    const err = new CliError('cancelled', 'Cancelled.');
    expect(err.hint).toBeUndefined();
    expect(err.details).toBeUndefined();
    expect(err.exitCode).toBe(5);
  });
});
