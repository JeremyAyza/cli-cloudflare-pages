import { describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/core/redact.js';

describe('createRedactor', () => {
  it('redacts registered secrets', () => {
    const r = createRedactor();
    r.add('cfat_abcdefgh12345678');
    expect(r.apply('token cfat_abcdefgh12345678 failed')).toBe('token [redacted] failed');
  });

  it('redacts bearer headers and cf token shapes even if unregistered', () =>
    expect(createRedactor().apply('Authorization: Bearer xyz123 / cfut_zzzzzzzzzz')).toBe(
      'Authorization: Bearer [redacted] / [redacted]',
    ));

  it('ignores secrets shorter than 4 chars', () => {
    const r = createRedactor();
    r.add('1');
    expect(r.apply('v1.2')).toBe('v1.2');
  });

  it('redacts the longest registered secret first', () => {
    const r = createRedactor();
    r.add('abcd');
    r.add('abcdefgh');
    expect(r.apply('value abcdefgh end')).toBe('value [redacted] end');
  });
});
