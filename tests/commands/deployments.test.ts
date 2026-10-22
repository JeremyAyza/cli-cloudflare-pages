import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { makeDeployment, makeProject } from '../fixtures/pages.js';
import { ACCT, cfUrl, ok } from '../helpers/cf.js';
import { loggedIn, runCli } from '../helpers/run.js';
import { server } from '../setup.js';

describe('deployments list & show', () => {
  it('list --json returns DeploymentView[]', async () => {
    const d1 = makeDeployment({ id: 'dep-1', short_id: 'dep11111' });
    const d2 = makeDeployment({ id: 'dep-2', short_id: 'dep22222' });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), () =>
        ok([d1, d2], { page: 1, per_page: 25, total_pages: 1 }),
      ),
    );

    const opts = await loggedIn();
    const res = await runCli(['deployments', 'list', 'my-site', '--json'], opts);

    expect(res.exitCode).toBe(0);
    const body = res.json<{ ok: boolean; data: Array<{ id: string; shortId: string }> }>();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.id).toBe('dep-1');
  });

  it('show --json returns DeploymentView', async () => {
    const d = makeDeployment({ id: 'dep-1', short_id: 'dep11111' });

    server.use(http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/dep-1`), () => ok(d)));

    const opts = await loggedIn();
    const res = await runCli(['deployments', 'show', 'my-site', 'dep-1', '--json'], opts);

    expect(res.exitCode).toBe(0);
    const body = res.json<{ ok: boolean; data: { id: string; url: string; dashboardUrl: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('dep-1');
    expect(body.data.dashboardUrl).toContain('dep-1');
  });
});

describe('deployments logs', () => {
  it('logs --tail 2 --json returns truncated lines', async () => {
    const d = makeDeployment({ id: 'dep-1' });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), () =>
        ok([d], { page: 1, per_page: 25, total_pages: 1 }),
      ),
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/dep-1/history/logs`), () =>
        ok({
          total: 3,
          includes_container_logs: true,
          data: [
            { ts: '2026-10-21T10:00:00Z', line: 'line 1' },
            { ts: '2026-10-21T10:00:01Z', line: 'line 2' },
            { ts: '2026-10-21T10:00:02Z', line: 'line 3' },
          ],
        }),
      ),
    );

    const opts = await loggedIn();
    const res = await runCli(['deployments', 'logs', 'my-site', '--tail', '2', '--json'], opts);

    expect(res.exitCode).toBe(0);
    const body = res.json<{ ok: boolean; data: { lines: string[] } }>();
    expect(body.ok).toBe(true);
    expect(body.data.lines).toHaveLength(2);
    expect(body.data.lines[0]).toContain('line 2');
    expect(body.data.lines[1]).toContain('line 3');
  });

  it('logs --output --json writes the file and still prints a single JSON document', async () => {
    const d = makeDeployment({ id: 'dep-1' });
    const dir = await mkdtemp(join(tmpdir(), 'cf-pages-logs-test-'));
    const file = join(dir, 'build.log');

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), () =>
        ok([d], { page: 1, per_page: 25, total_pages: 1 }),
      ),
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/dep-1/history/logs`), () =>
        ok({
          total: 2,
          includes_container_logs: true,
          data: [
            { ts: '2026-10-21T10:00:00Z', line: 'line 1' },
            { ts: '2026-10-21T10:00:01Z', line: 'line 2' },
          ],
        }),
      ),
    );

    try {
      const opts = await loggedIn();
      const res = await runCli(['deployments', 'logs', 'my-site', '--output', file, '--json'], opts);

      expect(res.exitCode).toBe(0);
      const body = res.json<{ ok: boolean; data: unknown }>();
      expect(body.ok).toBe(true);
      expect(body.data).toEqual({ deploymentId: 'dep-1', total: 2, savedTo: file, lineCount: 2 });
      expect(await readFile(file, 'utf8')).toBe('2026-10-21T10:00:00Z line 1\n2026-10-21T10:00:01Z line 2\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('deployments redeploy/retry/rollback', () => {
  it('redeploy on direct upload project exits 2 usage error', async () => {
    const p = makeProject({ name: 'direct-site', source: null });
    server.use(http.get(cfUrl(`/accounts/${ACCT}/pages/projects/direct-site`), () => ok(p)));

    const opts = await loggedIn();
    const res = await runCli(['deployments', 'redeploy', 'direct-site'], opts);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('Direct Upload');
  });

  it('redeploy production without confirmation in non-TTY exits 5', async () => {
    const p = makeProject({ name: 'my-site', production_branch: 'main' });
    server.use(http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(p)));

    const opts = await loggedIn({ tty: false });
    const res = await runCli(['deployments', 'redeploy', 'my-site'], opts);
    expect(res.exitCode).toBe(5);
  });

  it('redeploy --dry-run prints plan without triggering POST', async () => {
    let postTriggered = false;
    const p = makeProject({ name: 'my-site', production_branch: 'main' });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(p)),
      http.post(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), () => {
        postTriggered = true;
        return ok(makeDeployment());
      }),
    );

    const opts = await loggedIn();
    const res = await runCli(['deployments', 'redeploy', 'my-site', '--dry-run', '--json'], opts);

    expect(res.exitCode).toBe(0);
    expect(postTriggered).toBe(false);
    const body = res.json<{ ok: boolean; data: { dryRun: boolean; action: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.dryRun).toBe(true);
    expect(body.data.action).toBe('redeploy');
  });

  it('redeploy --confirm my-site triggers POST and succeeds', async () => {
    const p = makeProject({ name: 'my-site', production_branch: 'main' });
    const newDep = makeDeployment({ id: 'dep-redeploy-1' });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(p)),
      http.post(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), () => ok(newDep)),
    );

    const opts = await loggedIn();
    const res = await runCli(['deployments', 'redeploy', 'my-site', '--confirm', 'my-site', '--json'], opts);

    expect(res.exitCode).toBe(0);
    const body = res.json<{ ok: boolean; data: { id: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('dep-redeploy-1');
  });

  it('retry --confirm my-site triggers POST and succeeds', async () => {
    const target = makeDeployment({ id: 'dep-target', environment: 'production' });
    const retried = makeDeployment({ id: 'dep-retried' });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/dep-target`), () => ok(target)),
      http.post(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/dep-target/retry`), () => ok(retried)),
    );

    const opts = await loggedIn();
    const res = await runCli(['deployments', 'retry', 'my-site', 'dep-target', '--confirm', 'my-site', '--json'], opts);

    expect(res.exitCode).toBe(0);
    const body = res.json<{ ok: boolean; data: { id: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('dep-retried');
  });

  it('rollback --confirm my-site triggers rollback POST and succeeds', async () => {
    const target = makeDeployment({ id: 'dep-target', environment: 'production' });
    const rolled = makeDeployment({ id: 'dep-rolled' });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/dep-target`), () => ok(target)),
      http.post(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments/dep-target/rollback`), () => ok(rolled)),
    );

    const opts = await loggedIn();
    const res = await runCli(
      ['deployments', 'rollback', 'my-site', 'dep-target', '--confirm', 'my-site', '--json'],
      opts,
    );

    expect(res.exitCode).toBe(0);
    const body = res.json<{ ok: boolean; data: { id: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe('dep-rolled');
  });
});
