import { stat } from 'node:fs/promises';
import type { Command } from '@commander-js/extra-typings';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ACCT, cfUrl, fail, ok, recordRequests, settleRecordedRequests } from '../helpers/cf.js';
import { fakeIO, runCli } from '../helpers/run.js';
import { server } from '../setup.js';

describe('fakeIO', () => {
  it('captures stdout and stderr separately', () => {
    const io = fakeIO();
    io.stdout('a');
    io.stderr('b');
    io.stdout('c');
    expect([io.out, io.err]).toEqual(['ac', 'b']);
  });

  it('exposes tty and stdin options', async () => {
    const io = fakeIO({ tty: true, stdin: 'piped\n' });
    expect([io.stdinIsTTY, io.stdoutIsTTY, io.stderrIsTTY]).toEqual([true, true, true]);
    expect(await io.readStdin()).toBe('piped\n');
    const bare = fakeIO();
    expect([bare.stdinIsTTY, bare.stdoutIsTTY, bare.stderrIsTTY]).toEqual([false, false, false]);
    expect(await bare.readStdin()).toBe('');
  });

  it('replays scripted answers in order and records prompt messages', async () => {
    const io = fakeIO({ tty: true, answers: ['Acme', 'secret', true, 'main'] });
    expect(await io.prompts.text('Label')).toBe('Acme');
    expect(await io.prompts.password('Token')).toBe('secret');
    expect(await io.prompts.confirm('Proceed?')).toBe(true);
    expect(await io.prompts.select('Branch', [{ value: 'main', name: 'main' }])).toBe('main');
    expect([...io.prompts]).toEqual(['Label', 'Token', 'Proceed?', 'Branch']);
  });

  it('throws when a prompt is asked and no answer is left', async () => {
    const io = fakeIO({ tty: true });
    await expect(io.prompts.confirm('Delete everything?')).rejects.toThrow('Unexpected prompt: Delete everything?');
    expect([...io.prompts]).toEqual(['Delete everything?']);
  });

  it('rejects answers of the wrong kind or failing validation', async () => {
    const io = fakeIO({ answers: [true, 'x', 'long enough'] });
    await expect(io.prompts.text('Name')).rejects.toThrow(/string answer/);
    const validate = (v: string) => (v.length > 1 ? true : 'too short');
    await expect(io.prompts.text('Name', { validate })).rejects.toThrow(/too short/);
    await expect(io.prompts.text('Name', { validate })).resolves.toBe('long enough');
  });
});

describe('runCli', () => {
  it('starts from an empty env instead of process.env', async () => {
    let env: unknown;
    await runCli(['probe'], {
      configure: (p, ctx) => {
        env = ctx.env;
        p.command('probe').action(() => {});
      },
    });
    expect(env).toEqual({});
    const withEnv = await runCli(['probe'], {
      env: { CF_PAGES_ACCOUNT_ID: ACCT },
      configure: (p, ctx) => {
        env = ctx.env;
        p.command('probe').action(() => {});
      },
    });
    expect(withEnv.exitCode).toBe(0);
    expect(env).toEqual({ CF_PAGES_ACCOUNT_ID: ACCT });
  });

  it('gives each call a fresh config dir unless one is given', async () => {
    const dirs: string[] = [];
    const configure = (p: Command, ctx: { configDir: string }) => {
      dirs.push(ctx.configDir);
      p.command('probe').action(() => {});
    };
    await runCli(['probe'], { configure });
    await runCli(['probe'], { configure });
    await runCli(['probe'], { configure, configDir: '/explicit' });
    expect(dirs[0]).not.toBe(dirs[1]);
    expect((await stat(dirs[0] as string)).isDirectory()).toBe(true);
    expect(dirs[2]).toBe('/explicit');
  });

  it('feeds answers to prompts and reports them', async () => {
    const r = await runCli(['ask'], {
      tty: true,
      answers: [true],
      configure: (p, ctx) => {
        p.command('ask').action(async () => {
          ctx.io.stdout(`${await ctx.io.prompts.confirm('Continue?')}\n`);
        });
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('true\n');
    expect(r.prompts).toEqual(['Continue?']);
  });

  it('an unexpected prompt surfaces as an unexpected error, never a hang', async () => {
    const r = await runCli(['ask'], {
      tty: true,
      configure: (p, ctx) => {
        p.command('ask').action(async () => {
          await ctx.io.prompts.confirm('Continue?');
        });
      },
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Unexpected prompt: Continue?');
  });

  it('virtual clock: sleep resolves immediately and advances now()', async () => {
    const start = new Date('2026-01-01T00:00:00Z');
    let elapsed = -1;
    await runCli(['wait'], {
      now: start,
      configure: (p, ctx) => {
        p.command('wait').action(async () => {
          await ctx.sleep(5000);
          elapsed = ctx.now().getTime() - start.getTime();
        });
      },
    });
    expect(elapsed).toBe(5000);
  });

  it('json() rejects stdout that is not a single document', async () => {
    const r = await runCli(['probe'], {
      configure: (p, ctx) => {
        p.command('probe').action(() => {
          ctx.io.stdout('{"a":1}\n{"b":2}\n');
        });
      },
    });
    expect(() => r.json()).toThrow();
  });
});

describe('cf helpers', () => {
  it('ok() and fail() build Cloudflare envelopes', async () => {
    server.use(
      http.get(cfUrl(`/accounts/${ACCT}/pages/projects`), () => ok([{ name: 'my-site' }], { page: 1, total_count: 1 })),
      http.get(cfUrl('/missing'), () => fail(404, 8000007, 'Project not found')),
    );
    expect(await (await fetch(cfUrl(`/accounts/${ACCT}/pages/projects`))).json()).toEqual({
      success: true,
      errors: [],
      messages: [],
      result: [{ name: 'my-site' }],
      result_info: { page: 1, total_count: 1 },
    });
    const res = await fetch(cfUrl('missing'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      errors: [{ code: 8000007, message: 'Project not found' }],
      messages: [],
      result: null,
    });
  });

  it('recordRequests() captures method, path, search, json and form bodies', async () => {
    server.use(http.all(cfUrl('/*'), () => ok({})));
    const requests = recordRequests();
    await fetch(cfUrl('/accounts/a%2Fb/pages/projects?per_page=1'));
    await fetch(cfUrl('/things'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"k":"v"}',
    });
    const form = new FormData();
    form.set('branch', 'refactor/web-docs');
    await fetch(cfUrl('/deploy'), { method: 'POST', body: form });
    await settleRecordedRequests();
    expect(requests).toEqual([
      { method: 'GET', path: '/accounts/a%2Fb/pages/projects', search: '?per_page=1' },
      { method: 'POST', path: '/things', search: '', json: { k: 'v' } },
      { method: 'POST', path: '/deploy', search: '', form: { branch: 'refactor/web-docs' } },
    ]);
  });

  it('unhandled requests fail instead of reaching the network', async () => {
    await expect(fetch(cfUrl('/nothing-registered'))).rejects.toThrow();
  });
});
