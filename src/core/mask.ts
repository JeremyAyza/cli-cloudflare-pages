const DOTS = '•••';

/** Placeholder shown in place of a secret value that the API never returns. */
export const SECRET_PLACEHOLDER = '[secret — not readable]';

/**
 * Hides the middle of a value: 24+ chars keep 4 on each side, 12–23 keep 2, shorter values are fully hidden.
 * Works on code points so surrogate pairs (emoji) are never split.
 */
export function maskValue(value: string): string {
  const chars = [...value];
  const keep = chars.length >= 24 ? 4 : chars.length >= 12 ? 2 : 0;
  if (keep === 0) return '•••••';
  return chars.slice(0, keep).join('') + DOTS + chars.slice(-keep).join('');
}

/** Masked value followed by its length in code points, or `(empty)` for an empty value. */
export function describeMasked(value: string): string {
  if (value === '') return '(empty)';
  return `${maskValue(value)} (${[...value].length})`;
}
