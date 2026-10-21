import { HttpResponse } from 'msw';
import { server } from '../setup.js';

export const ACCT = '0123456789abcdef0123456789abcdef';

/** Token held by the fake keyring of `loggedIn()`. Shaped like an account token but not a real one. */
export const TEST_TOKEN = 'cfat_test_token_value_1234567890';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const API_PREFIX = new URL(API_BASE).pathname;

/** Absolute URL for an API path relative to `/client/v4`, e.g. `cfUrl('/accounts/…/pages/projects')`. */
export function cfUrl(path: string): string {
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Cloudflare success envelope. */
export function ok(result: unknown, resultInfo?: Record<string, unknown>): Response {
  return HttpResponse.json({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo ? { result_info: resultInfo } : {}),
  });
}

/** Cloudflare error envelope with the given HTTP status. */
export function fail(status: number, code: number, message: string): Response {
  return HttpResponse.json({ success: false, errors: [{ code, message }], messages: [], result: null }, { status });
}

export interface RecordedRequest {
  method: string;
  /** Path relative to `/client/v4`, percent-encoding preserved. */
  path: string;
  /** Raw query string including the leading `?`, or `''`. */
  search: string;
  json?: unknown;
  form?: Record<string, string>;
}

const pendingBodies = new Set<Promise<void>>();

/** Resolves once the bodies of all recorded requests have been parsed. */
export async function settleRecordedRequests(): Promise<void> {
  await Promise.all([...pendingBodies]);
}

async function readBody(request: Request, record: RecordedRequest): Promise<void> {
  const type = request.headers.get('content-type') ?? '';
  try {
    if (type.includes('application/json')) {
      record.json = await request.json();
    } else if (type.includes('multipart/form-data') || type.includes('application/x-www-form-urlencoded')) {
      const form: Record<string, string> = {};
      for (const [key, value] of await request.formData()) {
        form[key] = typeof value === 'string' ? value : `[file:${value.name}]`;
      }
      record.form = form;
    }
  } catch {
    // Unparseable body: leave json/form undefined.
  }
}

/** Starts recording every request msw sees. Listeners are removed after each test by `tests/setup.ts`. */
export function recordRequests(): RecordedRequest[] {
  const records: RecordedRequest[] = [];
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname;
    const record: RecordedRequest = { method: request.method, path, search: url.search };
    records.push(record);
    const pending = readBody(request.clone(), record).finally(() => pendingBodies.delete(pending));
    pendingBodies.add(pending);
  });
  return records;
}
