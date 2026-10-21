import { describe, expect, it } from 'vitest';
import { describeMasked, maskValue, SECRET_PLACEHOLDER } from '../../src/core/mask.js';

const s = (n: number) => 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'.slice(0, n);

describe('maskValue', () => {
  it('24+ chars: 4 + ••• + 4', () => expect(maskValue(s(24))).toBe('abcd•••uvwx'));
  it('23 chars: 2 + ••• + 2', () => expect(maskValue(s(23))).toBe('ab•••vw'));
  it('12 chars: 2 + ••• + 2', () => expect(maskValue(s(12))).toBe('ab•••kl'));
  it('11 chars: fully hidden', () => expect(maskValue(s(11))).toBe('•••••'));
});

describe('describeMasked', () => {
  it('describe adds length', () => expect(describeMasked(s(40))).toBe('abcd•••ABCD (40)'));
  it('empty value', () => expect(describeMasked('')).toBe('(empty)'));
  it('counts code points, never splits emoji', () =>
    expect(describeMasked('🔑'.repeat(24))).toBe('🔑🔑🔑🔑•••🔑🔑🔑🔑 (24)'));
});

describe('SECRET_PLACEHOLDER', () => {
  it('is the unreadable-secret marker', () => expect(SECRET_PLACEHOLDER).toBe('[secret — not readable]'));
});
