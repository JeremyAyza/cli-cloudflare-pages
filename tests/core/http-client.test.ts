import { HttpResponse, http } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { GlobalFlags } from '../../src/core/flags.js';
import {
  API_BASE,
  API_TOKENS_URL,
  ApiClient,
  type ApiClientOptions,
  ApiError,
  type RequestOptions,
} from '../../src/core/http/client.js';
import { createSession } from '../../src/core/session.js';
import { VERSION } from '../../src/version.js';
import { ACCT, cfUrl, fail, ok, recordRequests, settleRecordedRequests, TEST_TOKEN } from '../helpers/cf.js';
import { createTestContext, loggedIn } from '../helpers/run.js';
import { server } from '../setup.js';

const PROJECTS = `/accounts/${ACCT}/pages/projects`;
const APPLIED_HINT =
  'The request may or may not have been applied. Check the current state (`cf-pages deployments list <project>` or `cf-pages env list <project>`) before retrying.';
const INFO = { page: 1, per_page: 25, count: 1, total_count: 1, total_pages: 1 };

function makeClient(opts: Partial<ApiClientOptions> = {}) {
  const sleep = vi.fn(async (_ms: number) => {});
  const client = new ApiClient({ token: TEST_TOKEN, userAgent: 'cf-pages/1.2.3', sleep, ...opts });
  return { client, sleep };
}

/** Resolves when `request.signal` aborts, or after fallbackMs if it does not. Prevents orphaned handlers. */
function hangUntilAborted(request: Request, fallbackMs = 150): Promise<void> {
  return new Promise((resolve) => {
    if (request.signal.aborted) {
      resolve();
      return;
    }
    request.signal.addEventListener('abort', () => resolve(), { once: true });
    setTimeout(resolve, fallbackMs);
  });
}

/** Answers successive requests to `method path` with the given responders; the last one repeats. */
function sequence(
  method: 'get' | 'post' | 'patch' | 'delete',
  path: string,
  ...responders: (() => Response | Promise<Response>)[]
) {
  let calls = 0;
  server.use(
    http[method](cfUrl(path), () => {
      const responder = responders[Math.min(calls, responders.length - 1)];
      calls += 1;
      if (!responder) throw new Error('sequence() needs at least one responder');
      return responder();
    }),
  );
  return { calls: () => calls };
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => {
      throw new Error('Expected the request to fail.');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

const get = (path = PROJECTS): RequestOptions => ({ method: 'GET', path });

describe('constants', () => {
  it('names the API base and the tokens page exactly', () => {
    expect(API_BASE).toBe('https://api.cloudflare.com/client/v4');
    expect(API_TOKENS_URL).toBe('https://dash.cloudflare.com/profile/api-tokens');
  });
});

describe('ApiClient construction', () => {
  it.each(['', 'abc def', `${TEST_TOKEN}\n`, 'token-\u00e9'])(
    'rejects the unsendable token %j with auth_invalid',
    (token) => {
      let err: unknown;
      try {
        makeClient({ token });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ code: 'auth_invalid', exitCode: 3 });
      // The message must not quote the token back (fetch's own error would).
      expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(TEST_TOKEN);
    },
  );
});

describe('ApiClient path safety', () => {
  const DEPLOYMENTS = `/accounts/${ACCT}/pages/projects/site/deployments`;

  it.each([
    ['raw ..', `${DEPLOYMENTS}/..`],
    ['raw .', `${DEPLOYMENTS}/.`],
    ['percent-encoded %2e%2e', `${DEPLOYMENTS}/%2e%2e`],
    ['upper-case %2E%2E', `${DEPLOYMENTS}/%2E%2E`],
    ['mixed .%2e', `${DEPLOYMENTS}/.%2e`],
    ['mixed %2e.', `${DEPLOYMENTS}/%2e.`],
    ['mixed-case %2e%2E', `${DEPLOYMENTS}/%2e%2E`],
    ['single %2e', `${DEPLOYMENTS}/%2e`],
    ['in the middle', `/accounts/${ACCT}/pages/projects/%2e%2e/deployments`],
    ['before a query-free tail', `${DEPLOYMENTS}/../latest`],
    ['without a leading slash', 'accounts/../user'],
    ['trailing slash after ..', `${DEPLOYMENTS}/../`],
    ['raw backslash separator', `${DEPLOYMENTS}\\..`],
    ['encoded slash before ..', `${DEPLOYMENTS}/x%2f..`],
    ['encoded backslash before ..', `${DEPLOYMENTS}/x%5C%2e%2e`],
    ['followed by a query-like tail', `${DEPLOYMENTS}/..?x=1`],
    ['tab inside segment', `${DEPLOYMENTS}/.\t.`],
    ['newline inside segment', `${DEPLOYMENTS}/.\n.`],
    ['carriage return inside segment', `${DEPLOYMENTS}/.\r.`],
    ['encoded tab %09', `${DEPLOYMENTS}/.%09.`],
    ['encoded newline %0a', `${DEPLOYMENTS}/foo%0abar`],
    ['raw null byte', `${DEPLOYMENTS}/foo\0bar`],
    ['encoded null byte %00', `${DEPLOYMENTS}/foo%00bar`],
  ])('rejects a dot path segment (%s) with a usage error before any request is sent', async (_label, path) => {
    const seen = recordRequests();
    const { client, sleep } = makeClient();
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      const err = await client.request({ method, path }).then(
        () => {
          throw new Error('Expected the request to be rejected.');
        },
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: 'usage', exitCode: 2 });
      expect((err as { hint?: string }).hint).toBeTruthy();
    }
    expect(seen).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not log a debug line for a rejected path', async () => {
    const lines: string[] = [];
    const { client } = makeClient({ debug: (line) => lines.push(line) });
    await expect(client.request({ method: 'GET', path: `${DEPLOYMENTS}/..` })).rejects.toMatchObject({ code: 'usage' });
    expect(lines).toEqual([]);
  });

  it.each([
    ['dots inside a segment', `${PROJECTS}/my.site`],
    ['an ellipsis segment', `${PROJECTS}/...`],
    ['a dotted extension', `${PROJECTS}/site.v2.0`],
    ['an encoded slash', `${PROJECTS}/${encodeURIComponent('a/b')}`],
    ['a dot only in the query', `${PROJECTS}`],
  ])('still sends a legitimate path (%s)', async (_label, path) => {
    const seen = recordRequests();
    server.use(http.get(cfUrl(PROJECTS), () => ok({})));
    server.use(http.get(cfUrl(`${PROJECTS}/*`), () => ok({})));
    await makeClient().client.request({ method: 'GET', path, query: { branch: '..' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe(path);
  });
});

describe('ApiClient success path', () => {
  it('sends Bearer token and User-Agent cf-pages/<version>; returns result and result_info', async () => {
    let headers: Headers | undefined;
    server.use(
      http.get(cfUrl(PROJECTS), ({ request }) => {
        headers = request.headers;
        return ok([{ name: 'my-site' }], INFO);
      }),
    );
    const { client } = makeClient({ userAgent: `cf-pages/${VERSION}` });
    const res = await client.request<{ name: string }[]>(get());
    expect(res).toEqual({ result: [{ name: 'my-site' }], resultInfo: INFO });
    expect(headers?.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`);
    expect(headers?.get('user-agent')).toBe(`cf-pages/${VERSION}`);
  });

  it('omits resultInfo when the response has no result_info', async () => {
    server.use(http.get(cfUrl(PROJECTS), () => ok({ name: 'my-site' })));
    const res = await makeClient().client.request(get());
    expect(res).toEqual({ result: { name: 'my-site' } });
    expect('resultInfo' in res).toBe(false);
  });

  it('builds the query string, leaving out undefined values', async () => {
    const seen = recordRequests();
    server.use(http.get(cfUrl(PROJECTS), () => ok([])));
    await makeClient().client.request({
      method: 'GET',
      path: PROJECTS,
      query: { page: 2, per_page: 10, env: undefined, branch: 'refactor/web-docs' },
    });
    expect(seen).toHaveLength(1);
    const params = new URLSearchParams(seen[0]?.search);
    expect(Object.fromEntries(params)).toEqual({ page: '2', per_page: '10', branch: 'refactor/web-docs' });
  });

  it('keeps percent-encoded path segments as given', async () => {
    const seen = recordRequests();
    server.use(http.get(cfUrl(`${PROJECTS}/*`), () => ok({})));
    const path = `${PROJECTS}/${encodeURIComponent('a/b')}`;
    await makeClient().client.request(get(path));
    expect(seen[0]?.path).toBe(path);
    expect(seen[0]?.path).toContain('a%2Fb');
  });

  it('sends a json body with its content type', async () => {
    const seen = recordRequests();
    server.use(http.post(cfUrl(PROJECTS), () => ok({ name: 'my-site' })));
    await makeClient().client.request({ method: 'POST', path: PROJECTS, json: { name: 'my-site' } });
    await settleRecordedRequests();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', json: { name: 'my-site' } });
  });

  it('form option sends multipart with branch=refactor/web-docs unencoded', async () => {
    const seen = recordRequests();
    let contentType: string | null | undefined;
    server.use(
      http.post(cfUrl(`${PROJECTS}/my-site/deployments`), ({ request }) => {
        contentType = request.headers.get('content-type');
        return ok({ id: 'd1' });
      }),
    );
    await makeClient().client.request({
      method: 'POST',
      path: `${PROJECTS}/my-site/deployments`,
      form: { branch: 'refactor/web-docs' },
    });
    await settleRecordedRequests();
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen[0]?.form).toEqual({ branch: 'refactor/web-docs' });
  });
});

describe('ApiClient retries (Review Focus 1)', () => {
  it('GET retries 5xx twice with backoff then succeeds', async () => {
    const seen = sequence(
      'get',
      PROJECTS,
      () => fail(500, 7003, 'boom'),
      () => fail(500, 7003, 'boom'),
      () => ok([]),
    );
    const { client, sleep } = makeClient();
    await expect(client.request(get())).resolves.toEqual({ result: [] });
    expect(seen.calls()).toBe(3);
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it('GET 503 x3 → ApiError api_error, exit 6', async () => {
    const seen = sequence('get', PROJECTS, () => fail(503, 7003, 'unavailable'));
    const { client, sleep } = makeClient();
    const err = await rejection(client.request(get()));
    expect(seen.calls()).toBe(3);
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
    expect(err).toMatchObject({ code: 'api_error', exitCode: 6, status: 503 });
    expect(err.message).toContain('503');
    expect(err.message).toContain('[7003] unavailable');
    expect(err.hint).not.toContain('may or may not have been applied');
  });

  it('GET honours maxRetries', async () => {
    const seen = sequence('get', PROJECTS, () => fail(500, 1, 'boom'));
    const { client, sleep } = makeClient({ maxRetries: 0 });
    await rejection(client.request(get()));
    expect(seen.calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('GET retries a network error and then succeeds', async () => {
    const seen = sequence(
      'get',
      PROJECTS,
      () => HttpResponse.error(),
      () => ok([]),
    );
    const { client, sleep } = makeClient();
    await expect(client.request(get())).resolves.toEqual({ result: [] });
    expect(seen.calls()).toBe(2);
    expect(sleep.mock.calls).toEqual([[500]]);
  });

  it('GET that keeps failing at the network level → api_error without the mutation hint', async () => {
    const seen = sequence('get', PROJECTS, () => HttpResponse.error());
    const err = await rejection(makeClient().client.request(get()));
    expect(seen.calls()).toBe(3);
    expect(err).toMatchObject({ code: 'api_error', exitCode: 6, status: 0 });
    expect(err.message).toContain('GET');
    expect(err.hint).not.toContain('may or may not have been applied');
  });

  it('POST 500 is NOT retried; hint says it may or may not have been applied', async () => {
    const seen = recordRequests();
    server.use(http.post(cfUrl(`${PROJECTS}/my-site/deployments`), () => fail(500, 8000000, 'internal')));
    const { client, sleep } = makeClient();
    const err = await rejection(
      client.request({ method: 'POST', path: `${PROJECTS}/my-site/deployments`, form: { branch: 'main' } }),
    );
    expect(seen).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).toMatchObject({ code: 'api_error', exitCode: 6, status: 500 });
    expect(err.hint).toContain('may or may not have been applied');
    expect(err.hint).toContain('cf-pages deployments list');
    expect(err.hint).toContain('cf-pages env list');
    expect(err.hint).toBe(APPLIED_HINT);
  });

  it.each([
    ['PATCH', 502],
    ['DELETE', 503],
    ['POST', 504],
  ] as const)('%s %i is never retried and carries the applied hint', async (method, status) => {
    const seen = recordRequests();
    server.use(
      http[method === 'PATCH' ? 'patch' : method === 'DELETE' ? 'delete' : 'post'](cfUrl(PROJECTS), () =>
        fail(status, 1, 'down'),
      ),
    );
    const { client, sleep } = makeClient();
    const err = await rejection(client.request({ method, path: PROJECTS }));
    expect(seen).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).toMatchObject({ code: 'api_error', status });
    expect(err.hint).toBe(APPLIED_HINT);
  });

  it('a mutation that times out is NOT retried and carries the applied hint', async () => {
    const seen = recordRequests();
    server.use(
      http.post(cfUrl(PROJECTS), async ({ request }) => {
        await hangUntilAborted(request);
        return ok({});
      }),
    );
    const { client, sleep } = makeClient({ timeoutMs: 30 });
    const err = await rejection(client.request({ method: 'POST', path: PROJECTS, json: {} }));
    expect(seen).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).toMatchObject({ code: 'api_error', exitCode: 6 });
    expect(err.message).toMatch(/timed out/i);
    expect(err.hint).toBe(APPLIED_HINT);
  });

  it('a mutation that fails at the network level is NOT retried and carries the applied hint', async () => {
    const seen = sequence('delete', `${PROJECTS}/my-site`, () => HttpResponse.error());
    const { client, sleep } = makeClient();
    const err = await rejection(client.request({ method: 'DELETE', path: `${PROJECTS}/my-site` }));
    expect(seen.calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(err.code).toBe('api_error');
    expect(err.hint).toBe(APPLIED_HINT);
  });

  it('GET that times out is retried with backoff, then fails without the mutation hint', async () => {
    const seen = recordRequests();
    server.use(
      http.get(cfUrl(PROJECTS), async ({ request }) => {
        await hangUntilAborted(request);
        return ok([]);
      }),
    );
    const { client, sleep } = makeClient({ timeoutMs: 30 });
    const err = await rejection(client.request(get()));
    expect(seen).toHaveLength(3);
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
    expect(err).toMatchObject({ code: 'api_error' });
    expect(err.message).toMatch(/timed out/i);
    expect(err.hint).not.toContain('may or may not have been applied');
  });

  it('POST 429 retry-after 2 → retried once and succeeds', async () => {
    const seen = sequence(
      'post',
      PROJECTS,
      () =>
        HttpResponse.json(
          { success: false, errors: [{ code: 971, message: 'slow down' }] },
          { status: 429, headers: { 'retry-after': '2' } },
        ),
      () => ok({ name: 'my-site' }),
    );
    const { client, sleep } = makeClient();
    await expect(client.request({ method: 'POST', path: PROJECTS, json: {} })).resolves.toEqual({
      result: { name: 'my-site' },
    });
    expect(seen.calls()).toBe(2);
    expect(sleep.mock.calls).toEqual([[2000]]);
  });

  it('429 without retry-after waits 1 second, also for mutations', async () => {
    const seen = sequence(
      'delete',
      `${PROJECTS}/my-site`,
      () => fail(429, 971, 'slow down'),
      () => ok({}),
    );
    const { client, sleep } = makeClient();
    await client.request({ method: 'DELETE', path: `${PROJECTS}/my-site` });
    expect(seen.calls()).toBe(2);
    expect(sleep.mock.calls).toEqual([[1000]]);
  });

  it('429 retry-after 10 is still waited for', async () => {
    sequence(
      'get',
      PROJECTS,
      () => HttpResponse.json({ success: false, errors: [] }, { status: 429, headers: { 'retry-after': '10' } }),
      () => ok([]),
    );
    const { client, sleep } = makeClient();
    await client.request(get());
    expect(sleep.mock.calls).toEqual([[10_000]]);
  });

  it('429 retry-after 300 → rate_limited immediately, message mentions 300', async () => {
    const seen = sequence('get', PROJECTS, () =>
      HttpResponse.json(
        { success: false, errors: [{ code: 971, message: 'slow down' }] },
        { status: 429, headers: { 'retry-after': '300' } },
      ),
    );
    const { client, sleep } = makeClient();
    const err = await rejection(client.request(get()));
    expect(seen.calls()).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(err).toMatchObject({ code: 'rate_limited', exitCode: 6, status: 429 });
    expect(err.message).toContain('300');
  });

  it('429 that persists gives up with rate_limited once the retries are used', async () => {
    const seen = sequence('post', PROJECTS, () =>
      HttpResponse.json({ success: false, errors: [] }, { status: 429, headers: { 'retry-after': '1' } }),
    );
    const { client, sleep } = makeClient({ maxRetries: 2 });
    const err = await rejection(client.request({ method: 'POST', path: PROJECTS, json: {} }));
    expect(seen.calls()).toBe(3);
    expect(sleep.mock.calls).toEqual([[1000], [1000]]);
    expect(err).toMatchObject({ code: 'rate_limited', exitCode: 6 });
  });
});

describe('ApiClient error mapping', () => {
  it('401 → auth_invalid', async () => {
    server.use(http.get(cfUrl(PROJECTS), () => fail(401, 1000, 'Invalid API Token')));
    const err = await rejection(makeClient().client.request(get()));
    expect(err).toMatchObject({ code: 'auth_invalid', exitCode: 3, status: 401 });
    expect(err.message).toContain('Invalid API Token');
    expect(err.hint).toContain('cf-pages login');
    expect(err.hint).toContain(API_TOKENS_URL);
  });

  it('403 → permission_denied with API_TOKENS_URL in hint', async () => {
    server.use(http.get(cfUrl(PROJECTS), () => fail(403, 10000, 'Authentication error')));
    const err = await rejection(makeClient().client.request(get()));
    expect(err).toMatchObject({ code: 'permission_denied', exitCode: 3, status: 403 });
    expect(err.hint).toBe(
      `The API token needs the "Cloudflare Pages: Edit" permission (Read for read-only commands) on this account. Manage tokens: ${API_TOKENS_URL}`,
    );
  });

  it('404 → not_found', async () => {
    server.use(http.get(cfUrl(`${PROJECTS}/nope`), () => fail(404, 8000007, 'Project not found.')));
    const err = await rejection(makeClient().client.request(get(`${PROJECTS}/nope`)));
    expect(err).toMatchObject({ code: 'not_found', exitCode: 4, status: 404 });
    expect(err.message).toContain('Project not found.');
  });

  it.each([401, 403, 404])('%i is never retried', async (status) => {
    const seen = recordRequests();
    server.use(http.get(cfUrl(PROJECTS), () => fail(status, 1, 'no')));
    const { client, sleep } = makeClient();
    await rejection(client.request(get()));
    expect(seen).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('200 with success:false → api_error "[8000007] …"', async () => {
    server.use(
      http.post(cfUrl(PROJECTS), () =>
        HttpResponse.json({
          success: false,
          errors: [{ code: 8000007, message: 'Project not found.' }],
          messages: [],
          result: null,
        }),
      ),
    );
    const { client, sleep } = makeClient();
    const err = await rejection(client.request({ method: 'POST', path: PROJECTS, json: {} }));
    expect(err).toMatchObject({ code: 'api_error', exitCode: 6, status: 200 });
    expect(err.message).toBe('[8000007] Project not found.');
    expect(err.hint ?? '').not.toContain('may or may not have been applied');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('exposes status and cfErrors on a 4xx so callers can inspect the Cloudflare code', async () => {
    server.use(
      http.post(cfUrl(PROJECTS), () =>
        HttpResponse.json(
          {
            success: false,
            errors: [
              { code: 1000, message: 'Invalid request' },
              { code: 8000011, message: 'Name taken' },
            ],
          },
          { status: 400 },
        ),
      ),
    );
    const err = await rejection(makeClient().client.request({ method: 'POST', path: PROJECTS, json: {} }));
    expect(err).toMatchObject({ code: 'api_error', status: 400 });
    expect(err.cfErrors).toEqual([
      { code: 1000, message: 'Invalid request' },
      { code: 8000011, message: 'Name taken' },
    ]);
    expect(err.message).toContain('[1000] Invalid request');
    expect(err.message).toContain('[8000011] Name taken');
    expect(err.message).toContain('400');
  });

  it('a 4xx on a mutation does not claim the request may have been applied', async () => {
    server.use(http.post(cfUrl(PROJECTS), () => fail(409, 8000002, 'conflict')));
    const err = await rejection(makeClient().client.request({ method: 'POST', path: PROJECTS, json: {} }));
    expect(err).toMatchObject({ code: 'api_error', status: 409 });
    expect(err.hint ?? '').not.toContain('may or may not have been applied');
  });

  it('a non-JSON 5xx body (HTML 502) gives a clean api_error with the status, not a parse crash', async () => {
    server.use(
      http.get(cfUrl(PROJECTS), () =>
        HttpResponse.text('<html><body><h1>502 Bad Gateway</h1></body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );
    const err = await rejection(makeClient().client.request(get()));
    expect(err).toMatchObject({ code: 'api_error', exitCode: 6, status: 502, cfErrors: [] });
    expect(err.message).toContain('502');
    expect(err.message).not.toContain('<html>');
    expect(err.message).not.toMatch(/JSON/i);
  });

  it('a non-JSON 4xx body gives a clean api_error with the status', async () => {
    server.use(http.get(cfUrl(PROJECTS), () => HttpResponse.text('Bad request', { status: 400 })));
    const err = await rejection(makeClient().client.request(get()));
    expect(err).toMatchObject({ code: 'api_error', status: 400, cfErrors: [] });
    expect(err.message).toContain('400');
  });

  it('a non-JSON POST 502 still carries the applied hint', async () => {
    server.use(http.post(cfUrl(PROJECTS), () => HttpResponse.text('<html>502</html>', { status: 502 })));
    const err = await rejection(makeClient().client.request({ method: 'POST', path: PROJECTS, json: {} }));
    expect(err.hint).toBe(APPLIED_HINT);
  });

  it('a 2xx body that is not JSON → api_error, not a parse crash', async () => {
    server.use(http.get(cfUrl(PROJECTS), () => HttpResponse.text('OK', { status: 200 })));
    const err = await rejection(makeClient().client.request(get()));
    expect(err).toMatchObject({ code: 'api_error', status: 200 });
    expect(err.message).toContain('200');
  });

  it('never leaks the token in an error', async () => {
    server.use(http.get(cfUrl(PROJECTS), () => fail(500, 1, 'boom')));
    const err = await rejection(makeClient({ maxRetries: 0 }).client.request(get()));
    expect(JSON.stringify({ message: err.message, hint: err.hint, details: err.details })).not.toContain(TEST_TOKEN);
  });
});

describe('ApiClient debug logging', () => {
  it('debug lines never contain the token or bodies', async () => {
    const lines: string[] = [];
    server.use(http.post(cfUrl(PROJECTS), () => ok({ echoed: 'response-body-marker' })));
    const { client } = makeClient({ debug: (line) => lines.push(line) });
    await client.request({
      method: 'POST',
      path: PROJECTS,
      query: { page: 1 },
      json: { env: 'request-body-marker' },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^POST ${PROJECTS}\\?page=1 200 \\d+ms$`));
    const all = lines.join('\n');
    expect(all).not.toContain(TEST_TOKEN);
    expect(all).not.toContain('Bearer');
    expect(all).not.toContain('request-body-marker');
    expect(all).not.toContain('response-body-marker');
  });

  it('logs a line per attempt, including failed ones', async () => {
    const lines: string[] = [];
    sequence(
      'get',
      PROJECTS,
      () => fail(503, 1, 'secret-error-marker'),
      () => HttpResponse.error(),
      () => ok([]),
    );
    const { client } = makeClient({ debug: (line) => lines.push(line) });
    await client.request(get());
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(new RegExp(`^GET ${PROJECTS} 503 \\d+ms$`));
    expect(lines[1]).toMatch(new RegExp(`^GET ${PROJECTS} (network error|error) \\d+ms$`));
    expect(lines[2]).toMatch(new RegExp(`^GET ${PROJECTS} 200 \\d+ms$`));
    expect(lines.join('\n')).not.toContain('secret-error-marker');
  });

  it('works without a debug callback', async () => {
    server.use(http.get(cfUrl(PROJECTS), () => ok([])));
    await expect(makeClient().client.request(get())).resolves.toEqual({ result: [] });
  });
});

describe('session.client()', () => {
  const flags = (overrides: Partial<GlobalFlags> = {}): GlobalFlags => ({
    json: false,
    yes: false,
    dryRun: false,
    input: true,
    color: false,
    debug: false,
    ...overrides,
  });

  it('is memoized and built from the session credentials, user agent and sleep', async () => {
    const { ctx } = await createTestContext(await loggedIn());
    const open = vi.spyOn(ctx, 'openKeyring');
    const sleepSpy = vi.spyOn(ctx, 'sleep');
    let headers: Headers | undefined;
    sequence(
      'get',
      PROJECTS,
      () => fail(500, 1, 'boom'),
      () => ok([]),
    );
    server.use(
      http.get(cfUrl('/user/tokens/verify'), ({ request }) => {
        headers = request.headers;
        return ok({ status: 'active' });
      }),
    );
    const session = createSession(ctx, flags());
    const [a, b] = await Promise.all([session.client(), session.client()]);
    expect(a).toBe(b);
    expect(await session.client()).toBe(a);
    expect(open).toHaveBeenCalledTimes(1);

    await a.request({ method: 'GET', path: '/user/tokens/verify' });
    expect(headers?.get('authorization')).toBe(`Bearer ${TEST_TOKEN}`);
    expect(headers?.get('user-agent')).toBe(`cf-pages/${VERSION}`);

    await a.request(get());
    expect(sleepSpy).toHaveBeenCalledWith(500);
  });

  it('rejects like credentials() when there is no login', async () => {
    const { ctx } = await createTestContext();
    const session = createSession(ctx, flags());
    await expect(session.client()).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('with --debug writes redacted request lines to stderr; without it, nothing', async () => {
    server.use(http.get(cfUrl(PROJECTS), () => ok([])));

    const quiet = await createTestContext(await loggedIn());
    await (await createSession(quiet.ctx, flags()).client()).request(get());
    expect(quiet.io.err).not.toMatch(/GET /);

    const { ctx, io } = await createTestContext(await loggedIn());
    const client = await createSession(ctx, flags({ debug: true })).client();
    // The token in the query string proves the line goes through the session's redactor.
    await client.request({ method: 'GET', path: PROJECTS, query: { leak: TEST_TOKEN } });
    expect(io.err).toMatch(new RegExp(`GET ${PROJECTS}\\?leak=\\[redacted\\] 200 \\d+ms\\n$`));
    expect(io.err).not.toContain(TEST_TOKEN);
    expect(io.out).toBe('');
  });
});
