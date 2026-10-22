import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeProject } from '../fixtures/pages.js';
import { ACCT, cfUrl, ok } from '../helpers/cf.js';
import { loggedIn, runCli } from '../helpers/run.js';
import { server } from '../setup.js';

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cf-pages-env-test-'));
});
afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe('env list & get', () => {
  it('list without --env shows both environments masked; --json has no "value" field', async () => {
    const p = makeProject({
      name: 'my-site',
      deployment_configs: {
        production: {
          env_vars: {
            PROD_PLAIN: { type: 'plain_text', value: 'prod-plain-secret-value' },
            PROD_SECRET: { type: 'secret_text' },
          },
        },
        preview: {
          env_vars: {
            PREVIEW_VAR: { type: 'plain_text', value: 'preview-value' },
          },
        },
      },
    });

    server.use(http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(p)));

    const opts = await loggedIn();
    const res = await runCli(['env', 'list', 'my-site', '--json'], opts);

    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('prod-plain-secret-value');

    const body = res.json<{
      ok: boolean;
      data: {
        environments: {
          production: Array<{ key: string; value?: string; masked: string }>;
          preview: Array<{ key: string; value?: string }>;
        };
      };
    }>();
    expect(body.ok).toBe(true);
    expect(body.data.environments.production).toHaveLength(2);
    expect(body.data.environments.production[0]?.value).toBeUndefined();
  });

  it('get --reveal on secret → exit 2 usage error', async () => {
    const p = makeProject({
      name: 'my-site',
      deployment_configs: {
        production: {
          env_vars: { SECRET_KEY: { type: 'secret_text' } },
        },
      },
    });

    server.use(http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(p)));

    const opts = await loggedIn();
    const res = await runCli(['env', 'get', 'my-site', 'SECRET_KEY', '--env', 'production', '--reveal'], opts);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('Cloudflare does not return secret values');
  });

  it('get --reveal on plain → stdout exactly "<value>\\n", stderr warning', async () => {
    const p = makeProject({
      name: 'my-site',
      deployment_configs: {
        production: {
          env_vars: { PLAIN_KEY: { type: 'plain_text', value: 'visible-value-123' } },
        },
      },
    });

    server.use(http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(p)));

    const opts = await loggedIn();
    const res = await runCli(['env', 'get', 'my-site', 'PLAIN_KEY', '--env', 'production', '--reveal'], opts);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe('visible-value-123\n');
    expect(res.stderr).toContain("Revealing plain text value of 'PLAIN_KEY'");
  });
});

describe('env set & unset', () => {
  it('positional "KEY=value" → exit 2 usage error without requests', async () => {
    const opts = await loggedIn();
    const res = await runCli(['env', 'set', 'my-site', 'KEY=val', '--env', 'production'], opts);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain('Values are never accepted as arguments');
  });

  it('set from stdin strips one trailing newline and patches only that key', async () => {
    let patchPayload: unknown;
    const p = makeProject({
      name: 'my-site',
      deployment_configs: {
        preview: { env_vars: { OLD_KEY: { type: 'plain_text', value: 'keep-me' } } },
      },
    });
    let currentProject = p;

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(currentProject)),
      http.patch(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), async ({ request }) => {
        patchPayload = await request.json();
        currentProject = {
          ...p,
          deployment_configs: {
            ...p.deployment_configs,
            preview: {
              env_vars: {
                OLD_KEY: { type: 'plain_text', value: 'keep-me' },
                NEW_KEY: { type: 'plain_text', value: 'secret-hunter2' },
              },
            },
          },
        };
        return ok(currentProject);
      }),
    );

    const opts = await loggedIn({ stdin: 'secret-hunter2\n' });
    const res = await runCli(
      ['env', 'set', 'my-site', 'NEW_KEY', '--env', 'preview', '--plain', '--yes', '--json'],
      opts,
    );

    expect(res.exitCode).toBe(0);
    expect(patchPayload).toEqual({
      deployment_configs: {
        preview: {
          env_vars: {
            NEW_KEY: { type: 'plain_text', value: 'secret-hunter2' },
          },
        },
      },
    });
    // Secret was added to redactor, stdout never contains it
    expect(res.stdout).not.toContain('secret-hunter2');
  });

  it('set --dry-run prints masked diff without applying PATCH', async () => {
    let patchCalled = false;
    const p = makeProject({ name: 'my-site' });

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(p)),
      http.patch(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => {
        patchCalled = true;
        return ok(p);
      }),
    );

    const opts = await loggedIn({ stdin: 'my-val\n' });
    const res = await runCli(
      ['env', 'set', 'my-site', 'A', '--env', 'preview', '--plain', '--dry-run', '--json'],
      opts,
    );

    expect(res.exitCode).toBe(0);
    expect(patchCalled).toBe(false);
    const body = res.json<{ ok: boolean; data: { dryRun: boolean; applied: boolean } }>();
    expect(body.ok).toBe(true);
    expect(body.data.dryRun).toBe(true);
    expect(body.data.applied).toBe(false);
  });

  it('set --from-file patches keys from dotenv file', async () => {
    let patchPayload: unknown;
    const p = makeProject({ name: 'my-site' });
    let currentProject = p;
    const envFilePath = join(tempDir, '.env');
    await writeFile(envFilePath, 'FOO=bar\nBAZ=qux\n', 'utf8');

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(currentProject)),
      http.patch(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), async ({ request }) => {
        patchPayload = await request.json();
        currentProject = {
          ...p,
          deployment_configs: {
            ...p.deployment_configs,
            production: {
              env_vars: {
                FOO: { type: 'plain_text', value: 'bar' },
                BAZ: { type: 'plain_text', value: 'qux' },
              },
            },
          },
        };
        return ok(currentProject);
      }),
    );

    const opts = await loggedIn();
    const res = await runCli(
      [
        'env',
        'set',
        'my-site',
        '--env',
        'production',
        '--from-file',
        envFilePath,
        '--plain',
        '--confirm',
        'my-site',
        '--json',
      ],
      opts,
    );

    expect(res.exitCode).toBe(0);
    expect(patchPayload).toEqual({
      deployment_configs: {
        production: {
          env_vars: {
            FOO: { type: 'plain_text', value: 'bar' },
            BAZ: { type: 'plain_text', value: 'qux' },
          },
        },
      },
    });
  });

  it('unset sends KEY: null', async () => {
    let patchPayload: unknown;
    const p = makeProject({
      name: 'my-site',
      deployment_configs: {
        production: { env_vars: { DROP_ME: { type: 'plain_text', value: 'bye' } } },
      },
    });
    let currentProject = p;

    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), () => ok(currentProject)),
      http.patch(cfUrl(`/accounts/${ACCT}/pages/projects/my-site`), async ({ request }) => {
        patchPayload = await request.json();
        currentProject = {
          ...p,
          deployment_configs: { production: { env_vars: {} } },
        };
        return ok(currentProject);
      }),
    );

    const opts = await loggedIn();
    const res = await runCli(
      ['env', 'unset', 'my-site', 'DROP_ME', '--env', 'production', '--confirm', 'my-site', '--json'],
      opts,
    );

    expect(res.exitCode).toBe(0);
    expect(patchPayload).toEqual({
      deployment_configs: {
        production: {
          env_vars: {
            DROP_ME: null,
          },
        },
      },
    });
  });
});
