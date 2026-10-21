const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Human-friendly age of an ISO timestamp: `just now`, `5m ago`, `17h ago`, `3d ago`, or the ISO date past 30 days. */
export function relativeTime(iso: string, now: Date): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diff = now.getTime() - then;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(then).toISOString().slice(0, 10);
}
