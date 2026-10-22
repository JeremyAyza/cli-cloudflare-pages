import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { CliError } from '../../../src/core/errors.js';
import { ApiClient } from '../../../src/core/http/client.js';
import { PagesApi } from '../../../src/providers/pages/api.js';
import {
  collectDeployments,
  currentProductionDeployment,
  type DeploymentState,
  deploymentState,
  findRollbackTarget,
  isTerminal,
  latestByBranch,
  resolveDeploymentRef,
  waitForDeployment,
} from '../../../src/providers/pages/deployments.js';
import type { Deployment } from '../../../src/providers/pages/types.js';
import { makeDeployment, makeProject } from '../../fixtures/pages.js';
import { ACCT, cfUrl, fail, ok, TEST_TOKEN } from '../../helpers/cf.js';
import { server } from '../../setup.js';

function makeApi(): PagesApi {
  const sleep = async (_ms: number) => {};
  return new PagesApi(new ApiClient({ token: TEST_TOKEN, userAgent: 'cf-pages/test', sleep }), ACCT);
}

describe('deploymentState', () => {
  it.each<[string, Partial<Deployment>, DeploymentState]>([
    ['rule 1: is_skipped is skipped', { is_skipped: true }, 'skipped'],
    [
      'rule 2: latest_stage failure',
      { latest_stage: { name: 'build', status: 'failure', started_on: null, ended_on: null } },
      'failure',
    ],
    [
      'rule 2: latest_stage canceled',
      { latest_stage: { name: 'deploy', status: 'canceled', started_on: null, ended_on: null } },
      'canceled',
    ],
    [
      'rule 2: latest_stage skipped',
      { latest_stage: { name: 'clone_repo', status: 'skipped', started_on: null, ended_on: null } },
      'skipped',
    ],
    [
      'rule 3: deploy stage success',
      { latest_stage: { name: 'deploy', status: 'success', started_on: null, ended_on: null } },
      'success',
    ],
    [
      'rule 4: queued stage',
      { latest_stage: { name: 'queued', status: 'idle', started_on: null, ended_on: null } },
      'queued',
    ],
    [
      'rule 5: any other stage (building)',
      { latest_stage: { name: 'build', status: 'active', started_on: null, ended_on: null } },
      'building',
    ],
    [
      'rule 5: initialize stage (building)',
      { latest_stage: { name: 'initialize', status: 'success', started_on: null, ended_on: null } },
      'building',
    ],
  ])('deploymentState %s', (_desc, overrides, expected) => {
    const d = makeDeployment(overrides);
    expect(deploymentState(d)).toBe(expected);
  });
});

describe('isTerminal', () => {
  it.each<[DeploymentState, boolean]>([
    ['success', true],
    ['failure', true],
    ['canceled', true],
    ['skipped', true],
    ['queued', false],
    ['building', false],
  ])('isTerminal(%s) === %s', (state, expected) => {
    expect(isTerminal(state)).toBe(expected);
  });
});

describe('collectDeployments', () => {
  it('collectDeployments filters exact branch (refactor/web-docs ≠ refactor/web-docs-2) and sorts newest first', async () => {
    const d1 = makeDeployment({
      id: 'd1',
      created_on: '2026-10-20T10:00:00Z',
      deployment_trigger: { metadata: { branch: 'refactor/web-docs' } },
    });
    const d2 = makeDeployment({
      id: 'd2',
      created_on: '2026-10-20T12:00:00Z',
      deployment_trigger: { metadata: { branch: 'refactor/web-docs' } },
    });
    const d3 = makeDeployment({
      id: 'd3',
      created_on: '2026-10-20T11:00:00Z',
      deployment_trigger: { metadata: { branch: 'refactor/web-docs-2' } },
    });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), () =>
        ok([d1, d2, d3], { page: 1, per_page: 25, total_pages: 1 }),
      ),
    );

    const api = makeApi();
    const result = await collectDeployments(api, 'my-site', { branch: 'refactor/web-docs' });
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('d2');
    expect(result[1]?.id).toBe('d1');
  });

  it('collectDeployments stops at limit and at totalPages', async () => {
    const makeBatch = (page: number) =>
      Array.from({ length: 25 }, (_, i) =>
        makeDeployment({
          id: `p${page}-${i}`,
          created_on: new Date(Date.parse('2026-10-20T00:00:00Z') - (page * 25 + i) * 60000).toISOString(),
        }),
      );

    let pagesRequested = 0;
    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), ({ request }) => {
        pagesRequested++;
        const p = Number(new URL(request.url).searchParams.get('page') ?? '1');
        return ok(makeBatch(p), { page: p, per_page: 25, total_pages: 5 });
      }),
    );

    const api = makeApi();
    const limited = await collectDeployments(api, 'my-site', { limit: 30 });
    expect(limited).toHaveLength(30);
    expect(pagesRequested).toBe(2);

    pagesRequested = 0;
    const all = await collectDeployments(api, 'my-site');
    expect(all).toHaveLength(125);
    expect(pagesRequested).toBe(5);
  });
});

describe('latestByBranch', () => {
  it('returns newest deployment of each branch ordered newest first', () => {
    const dMainOld = makeDeployment({
      id: 'm1',
      created_on: '2026-10-20T08:00:00Z',
      deployment_trigger: { metadata: { branch: 'main' } },
    });
    const dMainNew = makeDeployment({
      id: 'm2',
      created_on: '2026-10-20T10:00:00Z',
      deployment_trigger: { metadata: { branch: 'main' } },
    });
    const dFeatOld = makeDeployment({
      id: 'f1',
      created_on: '2026-10-20T09:00:00Z',
      deployment_trigger: { metadata: { branch: 'feature/a' } },
    });
    const dFeatNew = makeDeployment({
      id: 'f2',
      created_on: '2026-10-20T11:00:00Z',
      deployment_trigger: { metadata: { branch: 'feature/a' } },
    });
    const dFix = makeDeployment({
      id: 'x1',
      created_on: '2026-10-20T07:00:00Z',
      deployment_trigger: { metadata: { branch: 'fix/b' } },
    });

    const res = latestByBranch([dMainOld, dMainNew, dFeatOld, dFeatNew, dFix]);
    expect(res).toEqual([
      { branch: 'feature/a', deployment: dFeatNew },
      { branch: 'main', deployment: dMainNew },
      { branch: 'fix/b', deployment: dFix },
    ]);
  });
});

describe('resolveDeploymentRef', () => {
  it('resolveDeploymentRef: latest, latest on branch, short id, full id, not found → exit 4 "No deployment with short id …"', async () => {
    const d1 = makeDeployment({
      id: '11112222-3333-4444-5555-666677778888',
      short_id: '11112222',
      created_on: '2026-10-20T10:00:00Z',
      deployment_trigger: { metadata: { branch: 'main' } },
    });
    const d2 = makeDeployment({
      id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
      short_id: 'aaaabbbb',
      created_on: '2026-10-20T11:00:00Z',
      deployment_trigger: { metadata: { branch: 'feat' } },
    });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), () =>
        ok([d2, d1], { page: 1, per_page: 25, total_pages: 1 }),
      ),
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/specific-id`), () => ok(d1)),
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/missing`), () =>
        fail(404, 8000000, 'Deployment not found'),
      ),
    );

    const api = makeApi();

    // latest
    const latest = await resolveDeploymentRef(api, 'my-site', undefined);
    expect(latest.id).toBe(d2.id);

    const latestStr = await resolveDeploymentRef(api, 'my-site', 'latest');
    expect(latestStr.id).toBe(d2.id);

    // latest on branch
    const latestBranch = await resolveDeploymentRef(api, 'my-site', 'latest', { branch: 'main' });
    expect(latestBranch.id).toBe(d1.id);

    // short id
    const byShort = await resolveDeploymentRef(api, 'my-site', '11112222');
    expect(byShort.id).toBe(d1.id);

    // short id not found
    await expect(resolveDeploymentRef(api, 'my-site', 'deadbeef')).rejects.toThrow(CliError);
    await expect(resolveDeploymentRef(api, 'my-site', 'deadbeef')).rejects.toMatchObject({
      code: 'not_found',
      message: "No deployment with short id 'deadbeef'.",
    });

    // full id
    const byFull = await resolveDeploymentRef(api, 'my-site', 'specific-id');
    expect(byFull.id).toBe(d1.id);
  });
});

describe('currentProductionDeployment', () => {
  it('prefers canonical_deployment, falls back to newest successful production deployment', () => {
    const canonical = makeDeployment({ id: 'c1', environment: 'production' });
    const p1 = makeProject({ canonical_deployment: canonical });
    expect(currentProductionDeployment(p1, [])).toBe(canonical);

    const p2 = makeProject({ canonical_deployment: null });
    const dPreview = makeDeployment({ id: 'dp', environment: 'preview', created_on: '2026-10-20T12:00:00Z' });
    const dFailed = makeDeployment({
      id: 'df',
      environment: 'production',
      created_on: '2026-10-20T11:00:00Z',
      latest_stage: { name: 'deploy', status: 'failure', started_on: null, ended_on: null },
    });
    const dSuccessOlder = makeDeployment({ id: 'ds1', environment: 'production', created_on: '2026-10-20T09:00:00Z' });
    const dSuccessNewer = makeDeployment({ id: 'ds2', environment: 'production', created_on: '2026-10-20T10:00:00Z' });

    const fallback = currentProductionDeployment(p2, [dPreview, dFailed, dSuccessOlder, dSuccessNewer]);
    expect(fallback?.id).toBe('ds2');

    expect(currentProductionDeployment(p2, [dPreview, dFailed])).toBeUndefined();
  });
});

describe('findRollbackTarget', () => {
  it('findRollbackTarget skips failed, skipped, preview and newer deployments', () => {
    const current = makeDeployment({
      id: 'curr',
      environment: 'production',
      created_on: '2026-10-20T10:00:00Z',
    });
    const newer = makeDeployment({
      id: 'd-newer',
      environment: 'production',
      created_on: '2026-10-20T11:00:00Z',
    });
    const preview = makeDeployment({
      id: 'd-prev',
      environment: 'preview',
      created_on: '2026-10-20T09:30:00Z',
    });
    const failed = makeDeployment({
      id: 'd-fail',
      environment: 'production',
      created_on: '2026-10-20T09:00:00Z',
      latest_stage: { name: 'deploy', status: 'failure', started_on: null, ended_on: null },
    });
    const skipped = makeDeployment({
      id: 'd-skip',
      environment: 'production',
      created_on: '2026-10-20T08:30:00Z',
      is_skipped: true,
    });
    const validTarget = makeDeployment({
      id: 'target',
      environment: 'production',
      created_on: '2026-10-20T08:00:00Z',
    });
    const olderValid = makeDeployment({
      id: 'older',
      environment: 'production',
      created_on: '2026-10-20T07:00:00Z',
    });

    const target = findRollbackTarget([newer, preview, failed, skipped, validTarget, olderValid], current);
    expect(target?.id).toBe('target');
  });
});

describe('waitForDeployment', () => {
  it('waitForDeployment polls until success, calling onState on each change', async () => {
    let call = 0;
    const states: DeploymentState[] = ['queued', 'building', 'building', 'success'];

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/dep-1`), () => {
        const stateName = states[call++] ?? 'success';
        const d = makeDeployment({
          id: 'dep-1',
          latest_stage:
            stateName === 'queued'
              ? { name: 'queued', status: 'idle', started_on: null, ended_on: null }
              : stateName === 'building'
                ? { name: 'build', status: 'active', started_on: null, ended_on: null }
                : { name: 'deploy', status: 'success', started_on: null, ended_on: null },
        });
        return ok(d);
      }),
    );

    const recordedStates: DeploymentState[] = [];
    const sleep = async () => {};
    const api = makeApi();

    const final = await waitForDeployment(api, 'my-site', 'dep-1', {
      sleep,
      intervalMs: 10,
      onState: (state) => recordedStates.push(state),
    });

    expect(final.id).toBe('dep-1');
    expect(deploymentState(final)).toBe('success');
    expect(recordedStates).toEqual(['queued', 'building', 'success']);
  });

  it('waitForDeployment times out after 20 minutes with api_error and dashboard hint', async () => {
    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/dep-slow`), () => {
        const d = makeDeployment({
          id: 'dep-slow',
          latest_stage: { name: 'build', status: 'active', started_on: null, ended_on: null },
        });
        return ok(d);
      }),
    );

    let currentTime = 1_000_000;
    const now = () => currentTime;
    const sleep = async (ms: number) => {
      currentTime += ms;
    };
    const api = makeApi();

    const err = await waitForDeployment(api, 'my-site', 'dep-slow', {
      sleep,
      now,
      intervalMs: 5000,
      timeoutMs: 1_200_000,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe('api_error');
    expect(err.message).toContain('timed out after 20 minutes');
    expect(err.hint).toContain(`https://dash.cloudflare.com/${ACCT}/pages/view/my-site/dep-slow`);
  });
});
