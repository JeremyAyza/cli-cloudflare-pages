import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { makeDeployment, makeProject } from '../fixtures/pages.js';
import { ACCT, cfUrl, ok } from '../helpers/cf.js';
import { loggedIn, runCli } from '../helpers/run.js';
import { server } from '../setup.js';

describe('projects list', () => {
  it('exits 3 without credentials', async () => {
    const res = await runCli(['projects', 'list']);
    expect(res.exitCode).toBe(3);
  });

  it('--json returns ProjectSummaryView[] with dashboardUrl', async () => {
    const p1 = makeProject({ name: 'site-a', subdomain: 'site-a.pages.dev' });
    const p2 = makeProject({ name: 'site-b', subdomain: 'site-b.pages.dev' });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects`), () =>
        ok([p1, p2], { page: 1, per_page: 10, total_pages: 1 }),
      ),
    );

    const opts = await loggedIn();
    const res = await runCli(['projects', 'list', '--json'], opts);

    expect(res.exitCode).toBe(0);
    const body = res.json<{ ok: boolean; data: Array<{ name: string; dashboardUrl: string }> }>();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.name).toBe('site-a');
    expect(body.data[0]?.dashboardUrl).toBe(`https://dash.cloudflare.com/${ACCT}/pages/view/site-a`);
    expect(body.data[1]?.name).toBe('site-b');
  });

  it('human mode shows project details', async () => {
    const p = makeProject({ name: 'my-site' });
    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects`), () => ok([p], { page: 1, per_page: 10, total_pages: 1 })),
    );

    const opts = await loggedIn();
    const res = await runCli(['projects', 'list'], opts);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('my-site');
    expect(res.stdout).toContain('https://dash.cloudflare.com');
  });
});

describe('projects show', () => {
  it('--expect with invalid hash exits 2 usage error', async () => {
    const opts = await loggedIn();
    const res1 = await runCli(['projects', 'show', 'my-site', '--expect', '12345'], opts);
    expect(res1.exitCode).toBe(2);

    const res2 = await runCli(['projects', 'show', 'my-site', '--expect', 'not-a-hex-sha'], opts);
    expect(res2.exitCode).toBe(2);
  });

  it('projects show --json never leaks env var values or web_analytics_token', async () => {
    const p = makeProject({
      name: 'my-site',
      build_config: { build_command: 'npm run build', destination_dir: 'dist', root_dir: '' },
      deployment_configs: {
        production: {
          env_vars: { SECRET_PLAIN: { type: 'plain_text', value: 'super-secret-plain-value' } },
        },
      },
    });
    // Cloudflare Pages API sometimes includes analytics token in build_config
    (p.build_config as Record<string, unknown>).web_analytics_token = 'wat-secret-analytics-token';

    const d = makeDeployment({
      id: 'dep-1',
      // Deployments returned by Cloudflare also have env_vars copies
      // @ts-expect-error
      env_vars: { LEAK_ME: { type: 'plain_text', value: 'leaked-deployment-env' } },
    });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(p)),
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/domains`), () => ok([])),
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), () =>
        ok([d], { page: 1, per_page: 25, total_pages: 1 }),
      ),
    );

    const opts = await loggedIn();
    const res = await runCli(['projects', 'show', 'my-site', '--json'], opts);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('super-secret-plain-value');
    expect(res.stdout).not.toContain('wat-secret-analytics-token');
    expect(res.stdout).not.toContain('leaked-deployment-env');

    const body = res.json<{ ok: boolean; data: { name: string; dashboardUrl: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('my-site');
  });

  it('findings report expect_found and expect_missing', async () => {
    const commitHash = 'abcdef0123456789abcdef0123456789abcdef01';
    const d = makeDeployment({
      id: 'dep-found',
      deployment_trigger: { metadata: { commit_hash: commitHash, branch: 'main' } },
    });
    const p = makeProject({ name: 'my-site' });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(p)),
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/domains`), () => ok([])),
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), () =>
        ok([d], { page: 1, per_page: 25, total_pages: 1 }),
      ),
    );

    const opts = await loggedIn();

    // expect found
    const resFound = await runCli(['projects', 'show', 'my-site', '--expect', 'abcdef0', '--json'], opts);
    expect(resFound.exitCode).toBe(0);
    const bodyFound = resFound.json<{ ok: boolean; data: { findings: Array<{ code: string }> } }>();
    expect(bodyFound.data.findings.some((f) => f.code === 'expect_found')).toBe(true);

    // expect missing
    const resMissing = await runCli(['projects', 'show', 'my-site', '--expect', '9999999', '--json'], opts);
    expect(resMissing.exitCode).toBe(0);
    const bodyMissing = resMissing.json<{ ok: boolean; data: { findings: Array<{ code: string }> } }>();
    expect(bodyMissing.data.findings.some((f) => f.code === 'expect_missing')).toBe(true);
  });
});
