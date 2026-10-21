import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_FILE } from '../../src/core/audit.js';
import { CONFIG_FILE, readConfig, writeConfig } from '../../src/core/config/store.js';
import type { Context } from '../../src/core/context.js';
import { CREDENTIALS_FILE } from '../../src/core/credentials/file-store.js';
import { KEYRING_HINT, PROFILE } from '../../src/core/credentials/types.js';
import { ACCT, cfUrl, fail, ok, recordRequests, TEST_TOKEN } from '../helpers/cf.js';
import { loggedIn, type RunOptions, type RunResult, runCli } from '../helpers/run.js';
import { server } from '../setup.js';

const GUIDANCE =
  'Create a token at https://dash.cloudflare.com/profile/api-tokens (or an account-owned token under Manage Account → Account API Tokens) with the permission: Account · Cloudflare Pages · Edit.';
const NOT_A_PERSON =
  'Login needs a person at a terminal. Run `cf-pages login` in your own terminal (or pipe the token with --token-stdin).';

const TOKEN = TEST_TOKEN;
const NEW_TOKEN = 'cfat_replacement_token_0987654321';
// No Cloudflare prefix: the redactor's token-shape pattern cannot hide it, so only a registered secret disappears.
const LEGACY_TOKEN = 'legacy-secret-token-0123456789abcdef';
const OTHER_ACCT = 'fedcba9876543210fedcba9876543210';

const ACCOUNT_VERIFY = cfUrl(`/accounts/${ACCT}/tokens/verify`);
const USER_VERIFY = cfUrl('/user/tokens/verify');
const PROJECTS = cfUrl(`/accounts/${ACCT}/pages/projects`);
const EMPTY_PAGE = { page: 1, per_page: 1, count: 0, total_count: 0, total_pages: 0 };

const posix = process.platform === 'win32' ? it.skip : it;

let configDir: string;
beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cf-pages-auth-'));
});
afterEach(async () => {
  await rm(configDir, { recursive: true, force: true });
});

const readText = (name: string) => readFile(join(configDir, name), 'utf8').catch(() => undefined);

/** Cloudflare accepts an account token and the account has Pages. */
function mockCloudflare(over: { status?: string; expiresOn?: string } = {}) {
  server.use(
    http.get(ACCOUNT_VERIFY, () =>
      ok({ id: 'tok1', status: over.status ?? 'active', ...(over.expiresOn ? { expires_on: over.expiresOn } : {}) }),
    ),
    http.get(PROJECTS, () => ok([], EMPTY_PAGE)),
  );
}

const STDIN_ARGS = ['login', '--token-stdin', '--label', 'Acme', '--account-id', ACCT];

/** Everything a person or a model could read after the run: output, prompts, config and the audit log. */
async function expectNoSecret(r: RunResult, secret: string) {
  expect(r.stdout).not.toContain(secret);
  expect(r.stderr).not.toContain(secret);
  expect(r.prompts.join('\n')).not.toContain(secret);
  expect((await readText(CONFIG_FILE)) ?? '').not.toContain(secret);
  expect((await readText(AUDIT_FILE)) ?? '').not.toContain(secret);
}

async function expectNothingStored(keyring: Map<string, string>) {
  expect(keyring.size).toBe(0);
  expect(await readText(CONFIG_FILE)).toBeUndefined();
  expect(await readText(CREDENTIALS_FILE)).toBeUndefined();
}

describe('login (interactive)', () => {
  it('interactive login stores token in keyring and profile in config', async () => {
    const requests = recordRequests();
    const seen: { authorization: string | null; userAgent: string | null }[] = [];
    server.use(
      http.get(ACCOUNT_VERIFY, ({ request }) => {
        seen.push({
          authorization: request.headers.get('authorization'),
          userAgent: request.headers.get('user-agent'),
        });
        return ok({ id: 'tok1', status: 'active', expires_on: '2099-01-01T00:00:00Z' });
      }),
      http.get(PROJECTS, () => ok([], EMPTY_PAGE)),
    );
    const keyring = new Map<string, string>();

    const r = await runCli(['login'], { tty: true, answers: ['Acme', ACCT, TOKEN], keyring, configDir });

    expect(r.exitCode).toBe(0);
    expect(requests.map((q) => `${q.method} ${q.path}${q.search}`)).toEqual([
      `GET /accounts/${ACCT}/tokens/verify`,
      `GET /accounts/${ACCT}/pages/projects?per_page=1`,
    ]);
    expect(seen).toEqual([{ authorization: `Bearer ${TOKEN}`, userAgent: expect.stringMatching(/^cf-pages\//) }]);
    expect(keyring.get(PROFILE)).toBe(TOKEN);
    const config = await readConfig(configDir);
    expect(config.profiles.default).toMatchObject({
      label: 'Acme',
      accountId: ACCT,
      storage: 'keyring',
      tokenType: 'account',
      tokenExpiresOn: '2099-01-01T00:00:00Z',
    });
    expect(Date.parse(config.profiles.default?.createdAt ?? '')).not.toBeNaN();
    expect(r.stdout).toContain('Acme');
    expect(r.stderr).toContain(GUIDANCE);
    expect(r.stderr).toContain('Cloudflare Pages · Edit');
    expect(r.stderr).toContain("can't be verified until the first change");
    expect(r.stderr).not.toContain('plain text');
    expect(r.prompts).toHaveLength(3);
    await expectNoSecret(r, TOKEN);
  });

  it('asks for the token with the hidden password prompt, never a visible one', async () => {
    mockCloudflare();
    let ctx: Context | undefined;
    let password: ReturnType<typeof vi.spyOn> | undefined;
    let text: ReturnType<typeof vi.spyOn> | undefined;
    const r = await runCli(['login'], {
      tty: true,
      answers: ['Acme', ACCT, TOKEN],
      configDir,
      configure: (_program, c) => {
        ctx = c;
        password = vi.spyOn(c.io.prompts, 'password');
        text = vi.spyOn(c.io.prompts, 'text');
      },
    });
    expect(r.exitCode).toBe(0);
    expect(password).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledTimes(2);
    expect(text?.mock.calls.flat().join('\n')).not.toContain(TOKEN);
    // The token was registered for redaction as soon as it was read.
    expect(ctx?.redactor.apply(`oops ${TOKEN}`)).toBe('oops [redacted]');
  });

  it('only asks for what the flags did not give', async () => {
    mockCloudflare();
    const keyring = new Map<string, string>();
    const r = await runCli(['login', '--label', 'Acme', '--account-id', ACCT], {
      tty: true,
      answers: [TOKEN],
      keyring,
      configDir,
    });
    expect(r.exitCode).toBe(0);
    expect(r.prompts).toHaveLength(1);
    expect(keyring.get(PROFILE)).toBe(TOKEN);
  });

  it('trims label and account id and a token typed with surrounding spaces', async () => {
    mockCloudflare();
    const keyring = new Map<string, string>();
    const r = await runCli(['login'], {
      tty: true,
      answers: ['  Acme  ', `  ${ACCT}  `, `  ${TOKEN}  `],
      keyring,
      configDir,
    });
    expect(r.exitCode).toBe(0);
    expect(keyring.get(PROFILE)).toBe(TOKEN);
    expect((await readConfig(configDir)).profiles.default).toMatchObject({ label: 'Acme', accountId: ACCT });
  });

  it('a token without a Cloudflare prefix falls back from the user to the account endpoint', async () => {
    const requests = recordRequests();
    server.use(
      http.get(USER_VERIFY, () => fail(401, 1000, 'Invalid API Token')),
      http.get(ACCOUNT_VERIFY, () => ok({ id: 'tok1', status: 'active' })),
      http.get(PROJECTS, () => ok([], EMPTY_PAGE)),
    );
    const keyring = new Map<string, string>();
    const r = await runCli(['login'], { tty: true, answers: ['Acme', ACCT, LEGACY_TOKEN], keyring, configDir });
    expect(r.exitCode).toBe(0);
    expect(requests.map((q) => `${q.method} ${q.path}`)).toEqual([
      'GET /user/tokens/verify',
      `GET /accounts/${ACCT}/tokens/verify`,
      `GET /accounts/${ACCT}/pages/projects`,
    ]);
    expect((await readConfig(configDir)).profiles.default?.tokenType).toBe('account');
    await expectNoSecret(r, LEGACY_TOKEN);
  });

  it('a user token is verified at /user/tokens/verify and saved as a user token', async () => {
    const requests = recordRequests();
    server.use(
      http.get(USER_VERIFY, () => ok({ id: 'tok1', status: 'active' })),
      http.get(PROJECTS, () => ok([], EMPTY_PAGE)),
    );
    const r = await runCli(['login'], {
      tty: true,
      answers: ['Acme', ACCT, 'cfut_user_token_value_1234567890'],
      configDir,
    });
    expect(r.exitCode).toBe(0);
    expect(requests.map((q) => q.path)).toEqual(['/user/tokens/verify', `/accounts/${ACCT}/pages/projects`]);
    expect((await readConfig(configDir)).profiles.default?.tokenType).toBe('user');
  });

  it('--token-stdin on a terminal still asks for the label and the Account ID, and not for the token', async () => {
    mockCloudflare();
    const keyring = new Map<string, string>();
    const r = await runCli(['login', '--token-stdin'], {
      tty: true,
      stdin: `${TOKEN}\n`,
      answers: ['Acme', ACCT],
      keyring,
      configDir,
    });
    expect(r.exitCode).toBe(0);
    expect(r.prompts).toHaveLength(2);
    expect(keyring.get(PROFILE)).toBe(TOKEN);
  });

  it('keyring unavailable → exit 3 with KEYRING_HINT before any prompt', async () => {
    const r = await runCli(['login', '--json'], { tty: true, answers: [], keyring: 'unavailable', configDir });
    expect(r.exitCode).toBe(3);
    expect(r.prompts).toHaveLength(0);
    expect(r.json()).toEqual({
      ok: false,
      error: { code: 'keyring_unavailable', message: expect.any(String), hint: KEYRING_HINT },
    });
    expect(await readText(CONFIG_FILE)).toBeUndefined();
    expect(await readText(CREDENTIALS_FILE)).toBeUndefined();
  });

  it('--json prints one document with the saved login and keeps notes on stderr', async () => {
    mockCloudflare();
    const r = await runCli(['login', '--json'], { tty: true, answers: ['Acme', ACCT, TOKEN], configDir });
    expect(r.exitCode).toBe(0);
    expect(r.json()).toEqual({
      ok: true,
      data: { label: 'Acme', accountId: ACCT, tokenType: 'account', storage: 'keyring', expiresOn: null },
    });
    expect(r.stderr).toContain("can't be verified until the first change");
  });

  it('records a login line in the audit log, without keys or values', async () => {
    mockCloudflare();
    const r = await runCli(['login'], { tty: true, answers: ['Acme', ACCT, TOKEN], configDir });
    expect(r.exitCode).toBe(0);
    const lines = ((await readText(AUDIT_FILE)) ?? '').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ts: expect.any(String),
      command: 'login',
      result: 'ok',
      credentialSource: 'keyring',
    });
  });

  it('keeps the settings already in config.json', async () => {
    mockCloudflare();
    await writeConfig(configDir, { version: 1, profiles: {}, settings: { productionRequiresTty: true } });
    const r = await runCli(['login'], { tty: true, answers: ['Acme', ACCT, TOKEN], configDir });
    expect(r.exitCode).toBe(0);
    expect((await readConfig(configDir)).settings).toEqual({ productionRequiresTty: true });
  });

  it('mentions environment variables that still take priority over the saved login', async () => {
    mockCloudflare();
    const r = await runCli(['login'], {
      tty: true,
      answers: ['Acme', ACCT, TOKEN],
      configDir,
      env: { CF_PAGES_API_TOKEN: 'x'.repeat(20), CF_PAGES_ACCOUNT_ID: ACCT },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('CF_PAGES_API_TOKEN');
    expect(r.stderr).toContain('priority');
  });

  it('--debug logs request lines without the token', async () => {
    mockCloudflare();
    const r = await runCli(['login', '--debug'], { tty: true, answers: ['Acme', ACCT, TOKEN], configDir });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(`GET /accounts/${ACCT}/tokens/verify 200`);
    await expectNoSecret(r, TOKEN);
  });
});

describe('login (non-interactive)', () => {
  it('non-TTY without --token-stdin → exit 3, asks a person to run login in their own terminal', async () => {
    const requests = recordRequests();
    const keyring = new Map<string, string>();
    const r = await runCli(['login', '--json'], { keyring, configDir });
    expect(r.exitCode).toBe(3);
    expect(r.json()).toEqual({ ok: false, error: { code: 'auth_required', message: NOT_A_PERSON } });
    expect(r.prompts).toHaveLength(0);
    expect(requests).toHaveLength(0);
    await expectNothingStored(keyring);
  });

  it('--no-input counts as no TTY even on a terminal', async () => {
    const r = await runCli(['login', '--no-input'], { tty: true, configDir });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain(NOT_A_PERSON);
    expect(r.prompts).toHaveLength(0);
  });

  it('--token-stdin with --label/--account-id works non-interactively', async () => {
    mockCloudflare();
    const keyring = new Map<string, string>();
    const r = await runCli(STDIN_ARGS, { stdin: `${TOKEN}\n`, keyring, configDir });
    expect(r.exitCode).toBe(0);
    expect(r.prompts).toHaveLength(0);
    expect(keyring.get(PROFILE)).toBe(TOKEN);
    expect((await readConfig(configDir)).profiles.default).toMatchObject({ label: 'Acme', accountId: ACCT });
    // The guidance is for the prompt: a pipe has nobody to read it.
    expect(r.stderr).not.toContain(GUIDANCE);
    await expectNoSecret(r, TOKEN);
  });

  it('strips the line ending the shell adds to piped input', async () => {
    mockCloudflare();
    const keyring = new Map<string, string>();
    const r = await runCli(STDIN_ARGS, { stdin: `${TOKEN}\r\n`, keyring, configDir });
    expect(r.exitCode).toBe(0);
    expect(keyring.get(PROFILE)).toBe(TOKEN);
  });

  it('--token-stdin without --label or --account-id → exit 2 naming what is missing', async () => {
    const requests = recordRequests();
    const keyring = new Map<string, string>();
    const r = await runCli(['login', '--token-stdin', '--json'], { stdin: TOKEN, keyring, configDir });
    expect(r.exitCode).toBe(2);
    const { error } = r.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe('usage');
    expect(error.message).toContain('--label');
    expect(error.message).toContain('--account-id');
    expect(requests).toHaveLength(0);
    await expectNothingStored(keyring);
    await expectNoSecret(r, TOKEN);
  });

  it('empty stdin → exit 2', async () => {
    const requests = recordRequests();
    const keyring = new Map<string, string>();
    const r = await runCli(STDIN_ARGS, { stdin: '  \n', keyring, configDir });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('empty');
    expect(requests).toHaveLength(0);
    await expectNothingStored(keyring);
  });

  it('a token with whitespace inside → exit 2 without echoing any of it', async () => {
    const requests = recordRequests();
    const keyring = new Map<string, string>();
    const r = await runCli(STDIN_ARGS, { stdin: 'legacy-first-part legacy-second-part\n', keyring, configDir });
    expect(r.exitCode).toBe(2);
    expect(requests).toHaveLength(0);
    await expectNothingStored(keyring);
    expect(r.stdout + r.stderr).not.toContain('legacy-first-part');
    expect(r.stdout + r.stderr).not.toContain('legacy-second-part');
  });

  it('a token with whitespace typed at the prompt → exit 2', async () => {
    const keyring = new Map<string, string>();
    const r = await runCli(['login'], { tty: true, answers: ['Acme', ACCT, 'cfat_part one'], keyring, configDir });
    expect(r.exitCode).toBe(2);
    await expectNothingStored(keyring);
    expect(r.stdout + r.stderr).not.toContain('cfat_part');
  });

  it('Global API Key rejected with exit 2 before any request', async () => {
    const requests = recordRequests();
    for (const key of ['cfk_global_key_value_1234567890', 'a'.repeat(37)]) {
      const keyring = new Map<string, string>();
      const r = await runCli([...STDIN_ARGS, '--json'], { stdin: key, keyring, configDir });
      expect(r.exitCode).toBe(2);
      const { error } = r.json<{ error: { code: string; message: string; hint?: string } }>();
      expect(error.code).toBe('usage');
      expect(error.message).toContain('Global API Key');
      expect(error.hint).toContain('https://dash.cloudflare.com/profile/api-tokens');
      expect(r.stdout + r.stderr).not.toContain(key);
      await expectNothingStored(keyring);
    }
    expect(requests).toHaveLength(0);
  });

  it('invalid account id format → exit 2', async () => {
    const requests = recordRequests();
    for (const bad of ['not-an-id', ACCT.toUpperCase(), ACCT.slice(1), `${ACCT}0`, 'g'.repeat(32)]) {
      const keyring = new Map<string, string>();
      const r = await runCli(['login', '--token-stdin', '--label', 'Acme', '--account-id', bad, '--json'], {
        stdin: TOKEN,
        keyring,
        configDir,
      });
      expect(r.exitCode, `account id ${bad}`).toBe(2);
      const { error } = r.json<{ error: { code: string; hint?: string } }>();
      expect(error.code).toBe('usage');
      expect(error.hint).toContain('https://dash.cloudflare.com');
      await expectNothingStored(keyring);
    }
    expect(requests).toHaveLength(0);
  });

  it('a token pasted as the label → exit 2, and it is neither echoed nor saved', async () => {
    const keyring = new Map<string, string>();
    const r = await runCli(['login', '--token-stdin', '--label', TOKEN, '--account-id', ACCT, '--json'], {
      stdin: TOKEN,
      keyring,
      configDir,
    });
    expect(r.exitCode).toBe(2);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('usage');
    await expectNothingStored(keyring);
    await expectNoSecret(r, TOKEN);
  });

  it('a label that is empty, too long or has control characters → exit 2', async () => {
    for (const label of ['   ', 'x'.repeat(65), 'bad\nlabel']) {
      const r = await runCli(['login', '--token-stdin', '--label', label, '--account-id', ACCT], {
        stdin: TOKEN,
        configDir,
      });
      expect(r.exitCode, JSON.stringify(label)).toBe(2);
    }
    mockCloudflare();
    const longest = await runCli(['login', '--token-stdin', '--label', 'x'.repeat(64), '--account-id', ACCT], {
      stdin: TOKEN,
      configDir,
    });
    expect(longest.exitCode).toBe(0);
  });

  it('the token is never accepted as an argument', async () => {
    const requests = recordRequests();
    for (const argv of [
      ['login', '--token', LEGACY_TOKEN],
      ['login', `--token=${LEGACY_TOKEN}`],
      ['login', LEGACY_TOKEN],
    ]) {
      const keyring = new Map<string, string>();
      const r = await runCli([...argv, '--json'], { tty: true, answers: [], keyring, configDir });
      expect(r.exitCode, argv.join(' ')).toBe(2);
      expect(r.stdout + r.stderr).not.toContain(LEGACY_TOKEN);
      expect(r.prompts).toHaveLength(0);
      await expectNothingStored(keyring);
    }
    expect(requests).toHaveLength(0);
  });

  it('login --token explains why and suggests the safe ways', async () => {
    const r = await runCli(['login', '--token', LEGACY_TOKEN, '--json'], { configDir });
    const { error } = r.json<{ error: { code: string; message: string; hint?: string } }>();
    expect(error.code).toBe('usage');
    expect(error.message).toContain('argument');
    expect(error.hint).toContain('--token-stdin');
  });

  it('login --help does not advertise a token argument', async () => {
    const r = await runCli(['login', '--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('--token-stdin');
    expect(r.stdout).not.toMatch(/--token\s/);
  });
});

describe('login (validation)', () => {
  it('token status "disabled" → exit 3, nothing stored', async () => {
    const requests = recordRequests();
    mockCloudflare({ status: 'disabled' });
    const keyring = new Map<string, string>();
    const r = await runCli([...STDIN_ARGS, '--json'], { stdin: TOKEN, keyring, configDir });
    expect(r.exitCode).toBe(3);
    const { error } = r.json<{ error: { code: string; message: string } }>();
    expect(error.code).toBe('auth_invalid');
    expect(error.message).toContain('disabled');
    // The Pages probe never ran for a token that is not active.
    expect(requests.map((q) => q.path)).toEqual([`/accounts/${ACCT}/tokens/verify`]);
    await expectNothingStored(keyring);
    expect((await readText(AUDIT_FILE)) ?? '').toBe('');
  });

  it('a token Cloudflare rejects (401) → exit 3, nothing stored', async () => {
    server.use(http.get(ACCOUNT_VERIFY, () => fail(401, 1000, 'Invalid API Token')));
    const keyring = new Map<string, string>();
    const r = await runCli(STDIN_ARGS, { stdin: TOKEN, keyring, configDir });
    expect(r.exitCode).toBe(3);
    await expectNothingStored(keyring);
    await expectNoSecret(r, TOKEN);
  });

  it('pages probe 403 → exit 3 permission_denied, nothing stored', async () => {
    server.use(
      http.get(ACCOUNT_VERIFY, () => ok({ id: 'tok1', status: 'active' })),
      http.get(PROJECTS, () => fail(403, 10000, 'Authentication error')),
    );
    const keyring = new Map<string, string>();
    const r = await runCli([...STDIN_ARGS, '--json'], { stdin: TOKEN, keyring, configDir });
    expect(r.exitCode).toBe(3);
    const { error } = r.json<{ error: { code: string; hint?: string } }>();
    expect(error.code).toBe('permission_denied');
    expect(error.hint).toContain('Account ID');
    await expectNothingStored(keyring);
  });

  it('pages probe 404 (no such account) → still nothing stored', async () => {
    server.use(
      http.get(ACCOUNT_VERIFY, () => ok({ id: 'tok1', status: 'active' })),
      http.get(PROJECTS, () => fail(404, 7003, 'No route for the URI')),
    );
    const keyring = new Map<string, string>();
    const r = await runCli(STDIN_ARGS, { stdin: TOKEN, keyring, configDir });
    expect(r.exitCode).toBe(4);
    await expectNothingStored(keyring);
  });

  it('a Cloudflare outage while verifying → exit 6, nothing stored', async () => {
    server.use(http.get(ACCOUNT_VERIFY, () => fail(500, 1, 'boom')));
    const keyring = new Map<string, string>();
    const r = await runCli(STDIN_ARGS, { stdin: TOKEN, keyring, configDir });
    expect(r.exitCode).toBe(6);
    await expectNothingStored(keyring);
  });

  it('a token that cannot go in an HTTP header → exit 3 without echoing it', async () => {
    const requests = recordRequests();
    const bad = 'cfat_café_token_value';
    const keyring = new Map<string, string>();
    const r = await runCli(STDIN_ARGS, { stdin: bad, keyring, configDir });
    expect(r.exitCode).toBe(3);
    expect(requests).toHaveLength(0);
    expect(r.stdout + r.stderr).not.toContain(bad);
    await expectNothingStored(keyring);
  });

  it('a keyring that fails to save leaves no profile behind', async () => {
    mockCloudflare();
    const r = await runCli(STDIN_ARGS, {
      stdin: TOKEN,
      configDir,
      configure: (_program, ctx) => {
        ctx.openKeyring = async () => ({
          kind: 'keyring',
          get: async () => null,
          set: async () => {
            throw new Error('keychain is locked');
          },
          delete: async () => false,
        });
      },
    });
    expect(r.exitCode).toBe(1);
    expect(await readText(CONFIG_FILE)).toBeUndefined();
  });

  it('--dry-run verifies the token but stores nothing', async () => {
    const requests = recordRequests();
    mockCloudflare();
    const keyring = new Map<string, string>();
    const r = await runCli([...STDIN_ARGS, '--dry-run', '--json'], { stdin: TOKEN, keyring, configDir });
    expect(r.exitCode).toBe(0);
    expect(r.json()).toEqual({
      ok: true,
      data: {
        dryRun: true,
        label: 'Acme',
        accountId: ACCT,
        tokenType: 'account',
        storage: 'keyring',
        expiresOn: null,
      },
    });
    expect(requests).toHaveLength(2);
    await expectNothingStored(keyring);
    expect(await readText(AUDIT_FILE)).toBeUndefined();
  });
});

describe('login --insecure-storage', () => {
  posix('--insecure-storage writes credentials.json 0600 and warns', async () => {
    mockCloudflare();
    // The keyring is out of the picture: nothing may touch it.
    const r = await runCli([...STDIN_ARGS, '--insecure-storage'], { stdin: TOKEN, keyring: 'unavailable', configDir });
    expect(r.exitCode).toBe(0);
    const path = join(configDir, CREDENTIALS_FILE);
    expect(JSON.parse((await readText(CREDENTIALS_FILE)) ?? '')).toEqual({ [PROFILE]: TOKEN });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    expect(r.stderr).toContain('Warning:');
    expect(r.stderr).toContain('plain text');
    expect(r.stderr).toContain(path);
    expect((await readConfig(configDir)).profiles.default).toMatchObject({ storage: 'file', tokenType: 'account' });
    await expectNoSecret(r, TOKEN);
  });

  it('warns before the first prompt', async () => {
    mockCloudflare();
    const r = await runCli(['login', '--insecure-storage', '--json'], {
      tty: true,
      answers: ['Acme', ACCT, TOKEN],
      keyring: 'unavailable',
      configDir,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('plain text');
    expect(r.json<{ data: { storage: string } }>().data.storage).toBe('file (insecure)');
  });

  it('whoami then shows the storage as file (insecure)', async () => {
    mockCloudflare();
    expect(
      (await runCli([...STDIN_ARGS, '--insecure-storage'], { stdin: TOKEN, keyring: 'unavailable', configDir }))
        .exitCode,
    ).toBe(0);

    const human = await runCli(['whoami'], { keyring: 'unavailable', configDir });
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('file (insecure)');

    const json = await runCli(['whoami', '--json'], { keyring: 'unavailable', configDir });
    expect(json.json<{ data: { storage: string; source: string } }>().data).toMatchObject({
      storage: 'file (insecure)',
      source: 'file',
    });
    await expectNoSecret(human, TOKEN);
    await expectNoSecret(json, TOKEN);
  });
});

describe('login over an existing login', () => {
  it('already logged in + non-TTY without --yes → exit 5', async () => {
    const requests = recordRequests();
    const opts = await loggedIn({ configDir, stdin: NEW_TOKEN });
    const r = await runCli([...STDIN_ARGS, '--json'], opts);
    expect(r.exitCode).toBe(5);
    const { error } = r.json<{ error: { code: string; message: string; hint?: string } }>();
    expect(error.code).toBe('confirmation_required');
    expect(error.message).toContain('Acme');
    expect(error.hint).toContain('--yes');
    expect(requests).toHaveLength(0);
    expect((opts.keyring as Map<string, string>).get(PROFILE)).toBe(TEST_TOKEN);
  });

  it('the replacement check comes before the person-at-a-terminal check', async () => {
    const opts = await loggedIn({ configDir });
    const r = await runCli(['login'], opts);
    expect(r.exitCode).toBe(5);
  });

  it('--yes replaces the saved login', async () => {
    mockCloudflare();
    const opts = await loggedIn({ configDir, stdin: NEW_TOKEN });
    const r = await runCli([...STDIN_ARGS, '--yes'], opts);
    expect(r.exitCode).toBe(0);
    expect((opts.keyring as Map<string, string>).get(PROFILE)).toBe(NEW_TOKEN);
    await expectNoSecret(r, NEW_TOKEN);
  });

  it('--confirm does not stand in for --yes', async () => {
    const opts = await loggedIn({ configDir, stdin: NEW_TOKEN });
    const r = await runCli([...STDIN_ARGS, '--confirm', 'my-site'], opts);
    expect(r.exitCode).toBe(5);
  });

  it('TTY asks "Replace the saved login" with a default of no', async () => {
    mockCloudflare();
    const opts = await loggedIn({ configDir, tty: true, answers: [true, 'Acme', ACCT, NEW_TOKEN] });
    let seenDefault: boolean | undefined;
    const r = await runCli(['login'], {
      ...opts,
      configure: (_program, ctx) => {
        const confirm = ctx.io.prompts.confirm.bind(ctx.io.prompts);
        ctx.io.prompts.confirm = async (message, o) => {
          seenDefault = o?.default;
          return confirm(message, o);
        };
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.prompts[0]).toBe('Replace the saved login "Acme"?');
    expect(seenDefault).toBe(false);
    expect((opts.keyring as Map<string, string>).get(PROFILE)).toBe(NEW_TOKEN);
  });

  it('answering no cancels with exit 5 and changes nothing', async () => {
    const requests = recordRequests();
    const opts = await loggedIn({ configDir, tty: true, answers: [false] });
    const r = await runCli(['login'], opts);
    expect(r.exitCode).toBe(5);
    expect(r.prompts).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect((opts.keyring as Map<string, string>).get(PROFILE)).toBe(TEST_TOKEN);
  });

  it('--yes skips the question on a terminal', async () => {
    mockCloudflare();
    const opts = await loggedIn({ configDir, tty: true, answers: ['Acme', ACCT, NEW_TOKEN] });
    const r = await runCli(['login', '--yes'], opts);
    expect(r.exitCode).toBe(0);
    expect(r.prompts).toHaveLength(3);
  });

  it('a failed replacement keeps the old login intact', async () => {
    mockCloudflare({ status: 'disabled' });
    const opts = await loggedIn({ configDir, stdin: NEW_TOKEN });
    const r = await runCli([...STDIN_ARGS, '--yes'], opts);
    expect(r.exitCode).toBe(3);
    expect((opts.keyring as Map<string, string>).get(PROFILE)).toBe(TEST_TOKEN);
    expect((await readConfig(configDir)).profiles.default).toMatchObject({ label: 'Acme' });
  });

  it('moving from the file to the keyring removes the plain-text copy', async () => {
    mockCloudflare();
    const first = await runCli([...STDIN_ARGS, '--insecure-storage'], {
      stdin: TOKEN,
      keyring: 'unavailable',
      configDir,
    });
    expect(first.exitCode).toBe(0);
    expect(await readText(CREDENTIALS_FILE)).toContain(TOKEN);

    const keyring = new Map<string, string>();
    const r = await runCli([...STDIN_ARGS, '--yes'], { stdin: NEW_TOKEN, keyring, configDir });
    expect(r.exitCode).toBe(0);
    expect(keyring.get(PROFILE)).toBe(NEW_TOKEN);
    expect(await readText(CREDENTIALS_FILE)).toBeUndefined();
    expect((await readConfig(configDir)).profiles.default?.storage).toBe('keyring');
  });

  it('moving from the keyring to the file removes the keychain entry', async () => {
    mockCloudflare();
    const opts = await loggedIn({ configDir, stdin: NEW_TOKEN });
    const r = await runCli([...STDIN_ARGS, '--yes', '--insecure-storage'], opts);
    expect(r.exitCode).toBe(0);
    expect((opts.keyring as Map<string, string>).has(PROFILE)).toBe(false);
    expect(JSON.parse((await readText(CREDENTIALS_FILE)) ?? '')).toEqual({ [PROFILE]: NEW_TOKEN });
  });

  it('warns when the old keychain entry cannot be removed', async () => {
    mockCloudflare();
    const opts = await loggedIn({ configDir, stdin: NEW_TOKEN });
    // The keychain was reachable for the old login and is gone now: the person switches to the file because of it.
    const r = await runCli([...STDIN_ARGS, '--yes', '--insecure-storage'], { ...opts, keyring: 'unavailable' });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('keyring');
    expect(r.stderr).toContain('Warning:');
  });
});

describe('logout', () => {
  it('logout clears keyring and profile; second logout says "Already logged out" with exit 0', async () => {
    const opts = await loggedIn({ configDir });
    const keyring = opts.keyring as Map<string, string>;
    await writeConfig(configDir, {
      ...(await readConfig(configDir)),
      settings: { productionRequiresTty: true },
    });

    const first = await runCli(['logout'], opts);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('Acme');
    expect(keyring.has(PROFILE)).toBe(false);
    const config = await readConfig(configDir);
    expect(config.profiles.default).toBeUndefined();
    expect(config.settings).toEqual({ productionRequiresTty: true });
    expect(first.stdout + first.stderr).not.toContain(TEST_TOKEN);

    const second = await runCli(['logout'], opts);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('Already logged out');
    expect(second.stderr).toBe('');
  });

  it('logout needs no terminal and no confirmation', async () => {
    const opts = await loggedIn({ configDir });
    const r = await runCli(['logout', '--no-input'], opts);
    expect(r.exitCode).toBe(0);
    expect(r.prompts).toHaveLength(0);
  });

  it('works on a machine that never logged in', async () => {
    const r = await runCli(['logout', '--json'], { configDir });
    expect(r.exitCode).toBe(0);
    expect(r.json()).toEqual({ ok: true, data: { loggedOut: false } });
    expect(await readText(CONFIG_FILE)).toBeUndefined();
  });

  it('--json reports what was removed', async () => {
    const opts = await loggedIn({ configDir });
    const r = await runCli(['logout', '--json'], opts);
    expect(r.json()).toEqual({
      ok: true,
      data: { loggedOut: true, label: 'Acme', accountId: ACCT, storage: 'keyring', tokenDeleted: true },
    });
  });

  it('removes the token from credentials.json for file storage', async () => {
    mockCloudflare();
    await runCli([...STDIN_ARGS, '--insecure-storage'], { stdin: TOKEN, keyring: 'unavailable', configDir });
    const r = await runCli(['logout'], { keyring: 'unavailable', configDir });
    expect(r.exitCode).toBe(0);
    expect(await readText(CREDENTIALS_FILE)).toBeUndefined();
    expect((await readConfig(configDir)).profiles.default).toBeUndefined();
  });

  it('leaves other secrets in credentials.json alone', async () => {
    mockCloudflare();
    await runCli([...STDIN_ARGS, '--insecure-storage'], { stdin: TOKEN, keyring: 'unavailable', configDir });
    await writeFile(join(configDir, CREDENTIALS_FILE), JSON.stringify({ [PROFILE]: TOKEN, other: 'keep-me' }), {
      mode: 0o600,
    });
    await runCli(['logout'], { keyring: 'unavailable', configDir });
    expect(JSON.parse((await readText(CREDENTIALS_FILE)) ?? '')).toEqual({ other: 'keep-me' });
  });

  it('notes that CF_PAGES_* variables still apply', async () => {
    const opts = await loggedIn({ configDir, env: { CF_PAGES_API_TOKEN: 'x'.repeat(24), CF_PAGES_ACCOUNT_ID: ACCT } });
    const r = await runCli(['logout'], opts);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('CF_PAGES_API_TOKEN');
    expect(r.stderr).toContain('still');
    expect(r.stderr).not.toContain('x'.repeat(24));
  });

  it('notes the variables even when there was nothing stored', async () => {
    const r = await runCli(['logout'], {
      configDir,
      env: { CF_PAGES_API_TOKEN: 'x'.repeat(24), CF_PAGES_ACCOUNT_ID: ACCT },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Already logged out');
    expect(r.stderr).toContain('CF_PAGES_API_TOKEN');
  });

  it('does not mention the variables when they are not set', async () => {
    const opts = await loggedIn({ configDir });
    const r = await runCli(['logout'], opts);
    expect(r.stderr).not.toContain('CF_PAGES');
  });

  it('still forgets the login when the keyring cannot be reached, and says the token may remain', async () => {
    const opts = await loggedIn({ configDir });
    const r = await runCli(['logout', '--json'], { ...opts, keyring: 'unavailable' });
    expect(r.exitCode).toBe(0);
    expect(r.json<{ data: { loggedOut: boolean; tokenDeleted: boolean } }>().data).toMatchObject({
      loggedOut: true,
      tokenDeleted: false,
    });
    expect(r.stderr).toContain('Warning:');
    expect(r.stderr).toContain('may still be');
    expect((await readConfig(configDir)).profiles.default).toBeUndefined();
    const human = await runCli(['logout'], { ...(await loggedIn({ configDir })), keyring: 'unavailable' });
    expect(human.stdout).toContain('could not be deleted');
  });

  it('keeps the login when the keyring fails for another reason, so logout can be retried', async () => {
    const opts = await loggedIn({ configDir });
    const r = await runCli(['logout'], {
      ...opts,
      configure: (_program, ctx) => {
        ctx.openKeyring = async () => ({
          kind: 'keyring',
          get: async () => null,
          set: async () => {},
          delete: async () => {
            throw new Error('keychain is locked');
          },
        });
      },
    });
    expect(r.exitCode).toBe(1);
    expect((await readConfig(configDir)).profiles.default).toMatchObject({ label: 'Acme' });
  });

  it('audits the logout', async () => {
    const opts = await loggedIn({ configDir });
    await runCli(['logout'], opts);
    const lines = ((await readText(AUDIT_FILE)) ?? '').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      ts: expect.any(String),
      command: 'logout',
      result: 'ok',
      credentialSource: 'keyring',
    });
  });

  it('does not audit a logout that had nothing to do', async () => {
    await runCli(['logout'], { configDir });
    expect(await readText(AUDIT_FILE)).toBeUndefined();
  });

  it('--dry-run changes nothing', async () => {
    const opts = await loggedIn({ configDir });
    const r = await runCli(['logout', '--dry-run', '--json'], opts);
    expect(r.exitCode).toBe(0);
    expect(r.json<{ data: { dryRun: boolean; loggedOut: boolean } }>().data).toMatchObject({
      dryRun: true,
      loggedOut: false,
    });
    expect((opts.keyring as Map<string, string>).get(PROFILE)).toBe(TEST_TOKEN);
    expect((await readConfig(configDir)).profiles.default).toMatchObject({ label: 'Acme' });
  });
});

describe('whoami', () => {
  const mockLive = (status = 'active', expiresOn?: string) =>
    server.use(
      http.get(ACCOUNT_VERIFY, () =>
        ok({ id: 'tok1', status, ...(expiresOn === undefined ? {} : { expires_on: expiresOn }) }),
      ),
    );

  it('whoami shows label, account, type, source, storage, expiry and live status, never the token', async () => {
    const requests = recordRequests();
    mockLive('active', '2099-01-01T00:00:00Z');
    const opts = await loggedIn({ configDir });
    const r = await runCli(['whoami'], opts);
    expect(r.exitCode).toBe(0);
    for (const expected of ['Acme', ACCT, 'account', 'keyring', '2099-01-01', 'active']) {
      expect(r.stdout, expected).toContain(expected);
    }
    expect(requests.map((q) => `${q.method} ${q.path}`)).toEqual([`GET /accounts/${ACCT}/tokens/verify`]);
    expect(r.stdout + r.stderr).not.toContain(TEST_TOKEN);
    expect(r.stderr).toContain('Acme');
  });

  it('--json data keys: label, accountId, tokenType, source, storage, expiresOn, status', async () => {
    mockLive('active', '2099-01-01T00:00:00Z');
    const r = await runCli(['whoami', '--json'], await loggedIn({ configDir }));
    expect(r.exitCode).toBe(0);
    const doc = r.json<{ ok: boolean; account: unknown; data: Record<string, unknown> }>();
    expect(doc.ok).toBe(true);
    expect(doc.account).toEqual({ label: 'Acme', accountId: ACCT });
    expect(doc.data).toEqual({
      label: 'Acme',
      accountId: ACCT,
      tokenType: 'account',
      source: 'keyring',
      storage: 'keyring',
      expiresOn: '2099-01-01T00:00:00Z',
      status: 'active',
    });
    expect(Object.keys(doc.data).sort()).toEqual(
      ['accountId', 'expiresOn', 'label', 'source', 'status', 'storage', 'tokenType'].sort(),
    );
    expect(r.stdout).not.toContain(TEST_TOKEN);
  });

  it('expiresOn is null when the token never expires', async () => {
    mockLive('active');
    const r = await runCli(['whoami', '--json'], await loggedIn({ configDir }));
    expect(r.json<{ data: { expiresOn: unknown } }>().data.expiresOn).toBeNull();
  });

  it('a user token is verified with the user endpoint', async () => {
    const requests = recordRequests();
    server.use(http.get(USER_VERIFY, () => ok({ id: 'tok1', status: 'active' })));
    const opts = await loggedIn({ configDir });
    const config = await readConfig(configDir);
    if (config.profiles.default) config.profiles.default.tokenType = 'user';
    await writeConfig(configDir, config);
    const r = await runCli(['whoami', '--json'], opts);
    expect(r.exitCode).toBe(0);
    expect(requests.map((q) => q.path)).toEqual(['/user/tokens/verify']);
    expect(r.json<{ data: { tokenType: string } }>().data.tokenType).toBe('user');
  });

  it('shows a status other than active and warns, with exit 0', async () => {
    mockLive('expired');
    const r = await runCli(['whoami'], await loggedIn({ configDir }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('expired');
    expect(r.stderr).toContain('Warning:');
  });

  it('warns when the token expires soon', async () => {
    const now = new Date('2026-10-21T12:00:00Z');
    mockLive('active', '2026-10-24T00:00:00Z');
    const opts = await loggedIn({ configDir, now });
    const config = await readConfig(configDir);
    if (config.profiles.default) config.profiles.default.tokenExpiresOn = '2026-10-24T00:00:00Z';
    await writeConfig(configDir, config);
    const r = await runCli(['whoami'], opts);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('expires on 2026-10-24');
  });

  it('prints what is known and exits 3 when Cloudflare rejects the token', async () => {
    server.use(http.get(ACCOUNT_VERIFY, () => fail(401, 1000, 'Invalid API Token')));
    const r = await runCli(['whoami'], await loggedIn({ configDir }));
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('Acme');
    expect(r.stdout).toContain(ACCT);
    expect(r.stdout).toContain('rejected');
    expect(r.stderr).toContain('Error:');
    expect(r.stderr).toContain('cf-pages login');
    expect(r.stdout + r.stderr).not.toContain(TEST_TOKEN);
  });

  it('--json: a rejected token is one error document that carries what is known', async () => {
    server.use(http.get(ACCOUNT_VERIFY, () => fail(401, 1000, 'Invalid API Token')));
    const r = await runCli(['whoami', '--json'], await loggedIn({ configDir }));
    expect(r.exitCode).toBe(3);
    const doc = r.json<{ ok: boolean; error: { code: string; details: { identity: Record<string, unknown> } } }>();
    expect(doc.ok).toBe(false);
    expect(doc.error.code).toBe('auth_invalid');
    expect(doc.error.details.identity).toEqual({
      label: 'Acme',
      accountId: ACCT,
      tokenType: 'account',
      source: 'keyring',
      storage: 'keyring',
      expiresOn: null,
      status: 'rejected',
    });
  });

  it('a 403 from the verify endpoint is an auth error too', async () => {
    server.use(http.get(ACCOUNT_VERIFY, () => fail(403, 10000, 'Authentication error')));
    const r = await runCli(['whoami'], await loggedIn({ configDir }));
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toContain('Acme');
  });

  it('a Cloudflare outage is not an auth error: exit 6 and no identity printed', async () => {
    server.use(http.get(ACCOUNT_VERIFY, () => fail(500, 1, 'boom')));
    const r = await runCli(['whoami'], await loggedIn({ configDir }));
    expect(r.exitCode).toBe(6);
    expect(r.stdout).toBe('');
  });

  it('not logged in → exit 3 auth_required', async () => {
    const r = await runCli(['whoami', '--json'], { configDir });
    expect(r.exitCode).toBe(3);
    expect(r.json<{ error: { code: string } }>().error.code).toBe('auth_required');
  });

  it('with env credentials: source env, no storage, type found by verification', async () => {
    server.use(
      http.get(USER_VERIFY, () => fail(401, 1000, 'Invalid API Token')),
      http.get(ACCOUNT_VERIFY, () => ok({ id: 'tok1', status: 'active' })),
    );
    const r = await runCli(['whoami', '--json'], {
      configDir,
      env: { CF_PAGES_API_TOKEN: LEGACY_TOKEN, CF_PAGES_ACCOUNT_ID: ACCT },
    });
    expect(r.exitCode).toBe(0);
    expect(r.json<{ data: Record<string, unknown> }>().data).toEqual({
      label: 'environment',
      accountId: ACCT,
      tokenType: 'account',
      source: 'env',
      storage: null,
      expiresOn: null,
      status: 'active',
    });
    expect(r.stdout + r.stderr).not.toContain(LEGACY_TOKEN);
  });

  it('env credentials win over the stored login and the human output says so', async () => {
    server.use(http.get(cfUrl(`/accounts/${OTHER_ACCT}/tokens/verify`), () => ok({ id: 'tok1', status: 'active' })));
    const opts = await loggedIn({
      configDir,
      env: { CF_PAGES_API_TOKEN: 'cfat_env_token_0123456789', CF_PAGES_ACCOUNT_ID: OTHER_ACCT },
    });
    const r = await runCli(['whoami'], opts);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(OTHER_ACCT);
    expect(r.stdout).toContain('environment');
    expect(r.stdout).not.toContain('Acme');
  });

  it('--debug shows the request line, not the token', async () => {
    mockLive();
    const r = await runCli(['whoami', '--debug'], await loggedIn({ configDir }));
    expect(r.stderr).toContain(`GET /accounts/${ACCT}/tokens/verify 200`);
    expect(r.stderr).not.toContain(TEST_TOKEN);
  });
});

describe('registration', () => {
  it('lists login, logout and whoami in --help', async () => {
    const r = await runCli(['--help']);
    for (const name of ['login', 'logout', 'whoami']) expect(r.stdout).toContain(name);
  });

  it('login needs no credentials, unlike every other command (it is the way in)', async () => {
    const opts: RunOptions = { configDir };
    const r = await runCli(['login'], opts);
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('Login needs a person');
  });
});
