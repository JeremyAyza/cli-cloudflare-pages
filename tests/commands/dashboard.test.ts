import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { makeDeployment } from '../fixtures/pages.js';
import { ACCT, cfUrl, ok } from '../helpers/cf.js';
import { loggedIn, runCli } from '../helpers/run.js';
import { server } from '../setup.js';

describe('dashboard command', () => {
  it('prints project URL without any API calls', async () => {
    let apiCalled = false;
    server.use(
      http.all(cfUrl('/*'), () => {
        apiCalled = true;
        return ok({});
      }),
    );

    const opts = await loggedIn();
    const res = await runCli(['dashboard', 'my-site', '--json'], opts);

    expect(res.exitCode).toBe(0);
    expect(apiCalled).toBe(false);
    const body = res.json<{ ok: boolean; data: { url: string } }>();
    expect(body.ok).toBe(true);
    expect(body.data.url).toBe(`https://dash.cloudflare.com/${ACCT}/pages/view/my-site`);
  });

  it('full deployment id does not call API, short id resolves via API', async () => {
    let listCalled = false;
    const fullId = '11112222-3333-4444-5555-666677778888';
    const shortId = 'aaaabbbb';
    const d = makeDeployment({ id: 'full-target-id', short_id: shortId });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site/deployments`), () => {
        listCalled = true;
        return ok([d], { page: 1, per_page: 25, total_pages: 1 });
      }),
    );

    const opts = await loggedIn();

    // Full ID: no API call
    const resFull = await runCli(['dashboard', 'my-site', fullId, '--json'], opts);
    expect(resFull.exitCode).toBe(0);
    expect(listCalled).toBe(false);
    expect(resFull.json<{ data: { url: string } }>().data.url).toBe(
      `https://dash.cloudflare.com/${ACCT}/pages/view/my-site/${fullId}`,
    );

    // Short ID: resolves via API
    const resShort = await runCli(['dashboard', 'my-site', shortId, '--json'], opts);
    expect(resShort.exitCode).toBe(0);
    expect(listCalled).toBe(true);
    expect(resShort.json<{ data: { url: string } }>().data.url).toBe(
      `https://dash.cloudflare.com/${ACCT}/pages/view/my-site/full-target-id`,
    );
  });

  it('section URL prints section path or falls back to project URL', async () => {
    const opts = await loggedIn();
    const res = await runCli(['dashboard', 'my-site', '--section', 'variables', '--json'], opts);
    expect(res.exitCode).toBe(0);
    const body = res.json<{ data: { url: string } }>();
    expect(body.data.url).toContain(`https://dash.cloudflare.com/${ACCT}/pages/view/my-site`);
  });

  it('--open in interactive TTY calls openUrl once', async () => {
    const opts = await loggedIn({ tty: true });
    const res = await runCli(['dashboard', 'my-site', '--open'], opts);

    expect(res.exitCode).toBe(0);
    expect(res.opened).toHaveLength(1);
    expect(res.opened[0]).toBe(`https://dash.cloudflare.com/${ACCT}/pages/view/my-site`);
  });

  it('--open without TTY notes that --open was ignored', async () => {
    const opts = await loggedIn({ tty: false });
    const res = await runCli(['dashboard', 'my-site', '--open'], opts);

    expect(res.exitCode).toBe(0);
    expect(res.opened).toHaveLength(0);
    expect(res.stderr).toContain('--open ignored: not an interactive terminal');
  });
});
