import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { pagesApi } from '../../../src/commands/shared.js';
import type { GlobalFlags } from '../../../src/core/flags.js';
import { ApiClient, ApiError } from '../../../src/core/http/client.js';
import { createSession } from '../../../src/core/session.js';
import { PagesApi } from '../../../src/providers/pages/api.js';
import { makeDeployment, makeProject } from '../../fixtures/pages.js';
import {
  ACCT,
  cfUrl,
  fail,
  ok,
  type RecordedRequest,
  recordRequests,
  settleRecordedRequests,
  TEST_TOKEN,
} from '../../helpers/cf.js';
import { createTestContext, loggedIn } from '../../helpers/run.js';
import { server } from '../../setup.js';

const PROJECTS = `/accounts/${ACCT}/pages/projects`;

function makeApi(): PagesApi {
  const sleep = async (_ms: number) => {};
  return new PagesApi(new ApiClient({ token: TEST_TOKEN, userAgent: 'cf-pages/test', sleep }), ACCT);
}

/** Answers every API request with the given result and records what was sent. */
function stubAll(result: unknown, resultInfo?: Record<string, unknown>): RecordedRequest[] {
  server.use(http.all(cfUrl('/*'), () => ok(result, resultInfo)));
  return recordRequests();
}

const query = (r: RecordedRequest | undefined) => new URLSearchParams(r?.search ?? '');

describe('probe', () => {
  it('probe → GET /accounts/ACCT/pages/projects?per_page=1', async () => {
    const requests = stubAll([]);
    await makeApi().probe();
    await settleRecordedRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'GET', path: PROJECTS, search: '?per_page=1' });
  });

  it('lets a 403 through as permission_denied', async () => {
    server.use(http.get(cfUrl(PROJECTS), () => fail(403, 10000, 'Authentication error')));
    await expect(makeApi().probe()).rejects.toMatchObject({ code: 'permission_denied' });
  });
});

describe('projects', () => {
  it('listProjects paginates until total_pages', async () => {
    const all = Array.from({ length: 23 }, (_, i) => makeProject({ name: `site-${i}` }));
    server.use(
      http.get(cfUrl(PROJECTS), ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
        const items = all.slice((page - 1) * 10, page * 10);
        return ok(items, { page, per_page: 10, count: items.length, total_count: 23, total_pages: 3 });
      }),
    );
    const requests = recordRequests();

    const projects = await makeApi().listProjects();

    expect(projects.map((p) => p.name)).toEqual(all.map((p) => p.name));
    expect(requests.map((r) => r.method)).toEqual(['GET', 'GET', 'GET']);
    expect(requests.map((r) => r.path)).toEqual([PROJECTS, PROJECTS, PROJECTS]);
    expect(requests.map((r) => query(r).get('page'))).toEqual(['1', '2', '3']);
    expect(requests.map((r) => query(r).get('per_page'))).toEqual(['10', '10', '10']);
  });

  it('listProjects treats a response without result_info as a single page', async () => {
    const requests = stubAll([makeProject()]);
    const projects = await makeApi().listProjects();
    expect(projects).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it('listProjects returns an empty list for an account without projects', async () => {
    stubAll([], { page: 1, per_page: 10, count: 0, total_count: 0, total_pages: 0 });
    await expect(makeApi().listProjects()).resolves.toEqual([]);
  });

  it('getProject → GET /pages/projects/<name> and returns the project', async () => {
    const project = makeProject();
    const requests = stubAll(project);
    await expect(makeApi().getProject('my-site')).resolves.toEqual(project);
    expect(requests[0]).toMatchObject({ method: 'GET', path: `${PROJECTS}/my-site`, search: '' });
  });
});

describe('deployments', () => {
  it('listDeploymentsPage passes env, page, per_page and returns items and totalPages', async () => {
    const items = [makeDeployment(), makeDeployment({ id: 'other-id' })];
    const requests = stubAll(items, { page: 2, per_page: 5, count: 2, total_count: 7, total_pages: 2 });

    const page = await makeApi().listDeploymentsPage('my-site', { env: 'preview', page: 2, perPage: 5 });

    expect(page).toEqual({ items, totalPages: 2 });
    expect(requests[0]).toMatchObject({ method: 'GET', path: `${PROJECTS}/my-site/deployments` });
    expect(Object.fromEntries(query(requests[0]))).toEqual({ env: 'preview', page: '2', per_page: '5' });
  });

  it('listDeploymentsPage leaves env out when it is not given', async () => {
    const requests = stubAll([]);
    await makeApi().listDeploymentsPage('my-site', { page: 1, perPage: 25 });
    expect(Object.fromEntries(query(requests[0]))).toEqual({ page: '1', per_page: '25' });
  });

  it('listDeploymentsPage counts a response without result_info as one page', async () => {
    const items = [makeDeployment()];
    stubAll(items);
    await expect(makeApi().listDeploymentsPage('my-site', { page: 1, perPage: 25 })).resolves.toEqual({
      items,
      totalPages: 1,
    });
  });

  it('getDeployment → GET /deployments/<id>', async () => {
    const deployment = makeDeployment();
    const requests = stubAll(deployment);
    await expect(makeApi().getDeployment('my-site', 'd1')).resolves.toEqual(deployment);
    expect(requests[0]).toMatchObject({ method: 'GET', path: `${PROJECTS}/my-site/deployments/d1` });
  });

  it('getDeploymentLogs → GET /deployments/<id>/history/logs', async () => {
    const logs = {
      total: 1,
      includes_container_logs: true,
      data: [{ ts: '2026-10-20T12:00:00.000Z', line: 'Cloning' }],
    };
    const requests = stubAll(logs);
    await expect(makeApi().getDeploymentLogs('my-site', 'd1')).resolves.toEqual(logs);
    expect(requests[0]).toMatchObject({ method: 'GET', path: `${PROJECTS}/my-site/deployments/d1/history/logs` });
  });

  it('createDeployment posts multipart with only branch field', async () => {
    const deployment = makeDeployment({ environment: 'preview' });
    const requests = stubAll(deployment);

    await expect(makeApi().createDeployment('my-site', 'refactor/web-docs')).resolves.toEqual(deployment);
    await settleRecordedRequests();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'POST', path: `${PROJECTS}/my-site/deployments`, search: '' });
    // The branch goes out raw: only path segments are percent-encoded.
    expect(requests[0]?.form).toEqual({ branch: 'refactor/web-docs' });
    expect(requests[0]?.json).toBeUndefined();
  });

  it.each(['retry', 'rollback'] as const)('%s POSTs to /deployments/<id>/%s without a body', async (action) => {
    const deployment = makeDeployment();
    const requests = stubAll(deployment);
    const api = makeApi();

    const result =
      action === 'retry' ? await api.retryDeployment('my-site', 'd1') : await api.rollbackDeployment('my-site', 'd1');
    await settleRecordedRequests();

    expect(result).toEqual(deployment);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: `${PROJECTS}/my-site/deployments/d1/${action}`,
      search: '',
    });
    expect(requests[0]?.json).toBeUndefined();
    expect(requests[0]?.form).toBeUndefined();
  });
});

describe('domains', () => {
  it('listDomains → GET /pages/projects/<name>/domains', async () => {
    const domains = [{ name: 'example.com', status: 'active' }];
    const requests = stubAll(domains);
    await expect(makeApi().listDomains('my-site')).resolves.toEqual(domains);
    expect(requests[0]).toMatchObject({ method: 'GET', path: `${PROJECTS}/my-site/domains` });
  });
});

describe('path segments', () => {
  it('are encodeURIComponent-ed', async () => {
    const requests = stubAll(makeDeployment());
    const api = makeApi();

    await api.getDeployment('my-site', 'a/b');
    await api.getDeploymentLogs('my-site', 'a/b');
    await api.retryDeployment('my-site', 'a/b');
    await api.rollbackDeployment('my-site', 'a/b');
    await api.getProject('my site/x');
    await api.listDomains('my site/x');
    await api.listDeploymentsPage('my site/x', { page: 1, perPage: 10 });
    await api.createDeployment('my site/x', 'main');
    await api.patchEnvVars('my site/x', 'production', {});
    await settleRecordedRequests();

    expect(requests.map((r) => r.path)).toEqual([
      `${PROJECTS}/my-site/deployments/a%2Fb`,
      `${PROJECTS}/my-site/deployments/a%2Fb/history/logs`,
      `${PROJECTS}/my-site/deployments/a%2Fb/retry`,
      `${PROJECTS}/my-site/deployments/a%2Fb/rollback`,
      `${PROJECTS}/my%20site%2Fx`,
      `${PROJECTS}/my%20site%2Fx/domains`,
      `${PROJECTS}/my%20site%2Fx/deployments`,
      `${PROJECTS}/my%20site%2Fx/deployments`,
      `${PROJECTS}/my%20site%2Fx`,
    ]);
  });

  it('cannot smuggle a dot segment past the client', async () => {
    const requests = stubAll(makeDeployment());
    await expect(makeApi().getDeployment('my-site', '..')).rejects.toMatchObject({ code: 'usage' });
    await expect(makeApi().getProject('.')).rejects.toMatchObject({ code: 'usage' });
    expect(requests).toHaveLength(0);
  });
});

describe('patchEnvVars', () => {
  it('sends exactly the patch under deployment_configs[env].env_vars', async () => {
    const project = makeProject();
    const requests = stubAll(project);

    const result = await makeApi().patchEnvVars('my-site', 'production', {
      A: { type: 'plain_text', value: '1' },
      B: null,
    });
    await settleRecordedRequests();

    expect(result).toEqual(project);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ method: 'PATCH', path: `${PROJECTS}/my-site`, search: '' });
    expect(requests[0]?.json).toEqual({
      deployment_configs: { production: { env_vars: { A: { type: 'plain_text', value: '1' }, B: null } } },
    });
  });

  it('targets the preview environment and sends secrets as secret_text', async () => {
    const requests = stubAll(makeProject());
    await makeApi().patchEnvVars('my-site', 'preview', { TOKEN: { type: 'secret_text', value: 's3cret' } });
    await settleRecordedRequests();
    expect(requests[0]?.json).toEqual({
      deployment_configs: { preview: { env_vars: { TOKEN: { type: 'secret_text', value: 's3cret' } } } },
    });
  });

  it('patchEnvVars keeps wrangler_config_hash when given', async () => {
    const requests = stubAll(makeProject());
    await makeApi().patchEnvVars('my-site', 'preview', { A: null }, { wranglerConfigHash: 'abc' });
    await settleRecordedRequests();
    expect(requests[0]?.json).toEqual({
      deployment_configs: { preview: { env_vars: { A: null }, wrangler_config_hash: 'abc' } },
    });
  });

  it.each([null, undefined, ''])('omits wrangler_config_hash when it is %j', async (hash) => {
    const requests = stubAll(makeProject());
    await makeApi().patchEnvVars('my-site', 'production', { A: null }, { wranglerConfigHash: hash });
    await settleRecordedRequests();
    expect(requests[0]?.json).toEqual({ deployment_configs: { production: { env_vars: { A: null } } } });
  });

  it('never reads the project first (no read-modify-write)', async () => {
    const requests = stubAll(makeProject());
    await makeApi().patchEnvVars('my-site', 'production', { A: null });
    expect(requests.map((r) => r.method)).toEqual(['PATCH']);
  });
});

describe('errors', () => {
  it('surface as ApiError from the client', async () => {
    server.use(http.get(cfUrl(`${PROJECTS}/missing`), () => fail(404, 8000007, 'Project not found')));
    const err = await makeApi()
      .getProject('missing')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'not_found' });
  });

  it('a malformed 200 body is not turned into data', async () => {
    server.use(http.get(cfUrl(PROJECTS), () => HttpResponse.text('<html>', { status: 200 })));
    await expect(makeApi().probe()).rejects.toMatchObject({ code: 'api_error' });
  });
});

describe('pagesApi(session)', () => {
  const flags: GlobalFlags = { json: false, yes: false, dryRun: false, input: true, color: false, debug: false };

  it('returns an api bound to the session account, and its account id', async () => {
    const { ctx } = await createTestContext(await loggedIn());
    const requests = stubAll([]);

    const { api, accountId } = await pagesApi(createSession(ctx, flags));

    expect(api).toBeInstanceOf(PagesApi);
    expect(accountId).toBe(ACCT);
    await api.probe();
    expect(requests[0]?.path).toBe(PROJECTS);
  });

  it('rejects like credentials() when there is no login', async () => {
    const { ctx } = await createTestContext();
    await expect(pagesApi(createSession(ctx, flags))).rejects.toMatchObject({ code: 'auth_required' });
  });
});
