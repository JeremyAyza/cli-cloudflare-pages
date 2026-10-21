import { describe, expect, it } from 'vitest';
import { relativeTime } from '../../src/core/time.js';

const now = new Date('2026-10-21T12:00:00Z');

describe('relativeTime', () => {
  it.each([
    ['2026-10-21T11:59:30Z', 'just now'],
    ['2026-10-21T11:55:00Z', '5m ago'],
    ['2026-10-20T19:00:00Z', '17h ago'],
    ['2026-10-18T12:00:00Z', '3d ago'],
    ['2026-09-01T00:00:00Z', '2026-09-01'],
    ['2026-10-22T00:00:00Z', 'just now'],
  ])('%s → %s', (iso, out) => expect(relativeTime(iso, now)).toBe(out));

  it('returns an unparseable timestamp unchanged instead of throwing', () =>
    expect(relativeTime('not-a-date', now)).toBe('not-a-date'));
});
