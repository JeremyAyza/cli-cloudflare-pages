import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUDIT_FILE } from '../../src/core/audit.js';
import { type ProfileConfig, readConfig, writeConfig } from '../../src/core/config/store.js';
import { createNodeContext } from '../../src/core/context.js';
import { fileSecretStore } from '../../src/core/credentials/file-store.js';
import { openKeyringStore } from '../../src/core/credentials/keyring-store.js';
import { resolveCredentials } from '../../src/core/credentials/resolve.js';
import {
  type Credentials,
  KEYRING_HINT,
  KEYRING_SERVICE,
  PROFILE,
  type SecretStore,
} from '../../src/core/credentials/types.js';
import type { GlobalFlags } from '../../src/core/flags.js';
import { createSession } from '../../src/core/session.js';
import { ACCT, TEST_TOKEN } from '../helpers/cf.js';
import { createTestContext, loggedIn } from '../helpers/run.js';

// An env token without a Cloudflare prefix: the redactor's token-shape pattern cannot catch it, so it only
// disappears from text if it was registered.
const ENV_TOKEN = 'legacy-env-token-0123456789abcdef';
const OTHER_ACCT = 'fedcba9876543210fedcba9876543210';
const ENV = { CF_PAGES_API_TOKEN: ENV_TOKEN, CF_PAGES_ACCOUNT_ID: ACCT };
const NOT_LOGGED_IN_HINT = 'Run `cf-pages login` in your terminal.';

const flags = (overrides: Partial<GlobalFlags> = {}): GlobalFlags => ({
  json: false,
  yes: false,
  dryRun: false,
  input: true,
  color: false,
  debug: false,
  ...overrides,
});

/** Changes fields of the stored `default` profile, as `login` would have written them. */
async function patchProfile(dir: string, patch: Partial<ProfileConfig>): Promise<void> {
  const config = await readConfig(dir);
  const profile = config.profiles.default;
  if (!profile) throw new Error('No stored profile to patch; start from loggedIn().');
  await writeConfig(dir, { ...config, profiles: { default: { ...profile, ...patch } } });
}

describe('constants', () => {
  it('names the keyring service, the profile and the hint exactly', () => {
    expect(KEYRING_SERVICE).toBe('cf-pages');
    expect(PROFILE).toBe('default');
    expect(KEYRING_HINT).toBe(
      'Set CF_PAGES_API_TOKEN and CF_PAGES_ACCOUNT_ID, or run `cf-pages login --insecure-storage` to store the token in a 0600 file.',
    );
  });

  it('the node context opens the real keyring lazily through openKeyringStore', () => {
    expect(createNodeContext().openKeyring).toBe(openKeyringStore);
  });
});

describe('resolveCredentials', () => {
  it('env vars take precedence over the stored profile (label from the profile)', async () => {
    const { ctx } = await createTestContext(await loggedIn({ env: ENV }));
    await expect(resolveCredentials(ctx)).resolves.toEqual({
      token: ENV_TOKEN,
      accountId: ACCT,
      label: 'Acme',
      source: 'env',
    });
  });

  it('env vars never open the keyring', async () => {
    const { ctx } = await createTestContext(await loggedIn({ env: ENV, keyring: 'unavailable' }));
    await expect(resolveCredentials(ctx)).resolves.toMatchObject({ source: 'env' });
  });

  it('env vars without a stored profile are labelled "environment"', async () => {
    const { ctx } = await createTestContext({ env: ENV });
    await expect(resolveCredentials(ctx)).resolves.toEqual({
      token: ENV_TOKEN,
      accountId: ACCT,
      label: 'environment',
      source: 'env',
    });
  });

  it('env vars for another account than the profile are not labelled with the profile', async () => {
    const { ctx } = await createTestContext(await loggedIn({ env: { ...ENV, CF_PAGES_ACCOUNT_ID: OTHER_ACCT } }));
    await expect(resolveCredentials(ctx)).resolves.toMatchObject({
      accountId: OTHER_ACCT,
      label: 'environment',
      source: 'env',
    });
  });

  it('trims env values and treats empty ones as unset', async () => {
    const trimmed = await createTestContext({
      env: { CF_PAGES_API_TOKEN: `  ${ENV_TOKEN}\n`, CF_PAGES_ACCOUNT_ID: `${ACCT} ` },
    });
    await expect(resolveCredentials(trimmed.ctx)).resolves.toMatchObject({ token: ENV_TOKEN, accountId: ACCT });

    const empty = await createTestContext({ env: { CF_PAGES_API_TOKEN: '', CF_PAGES_ACCOUNT_ID: '  ' } });
    await expect(resolveCredentials(empty.ctx)).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('only CF_PAGES_API_TOKEN set → auth_invalid naming CF_PAGES_ACCOUNT_ID', async () => {
    // Even with a stored login: a half-set environment is a mistake, not a reason to fall back.
    for (const opts of [{}, await loggedIn()]) {
      const { ctx } = await createTestContext({ ...opts, env: { CF_PAGES_API_TOKEN: ENV_TOKEN } });
      const err = await resolveCredentials(ctx).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'auth_invalid', message: expect.stringContaining('CF_PAGES_ACCOUNT_ID') });
      expect((err as Error).message).not.toContain(ENV_TOKEN);
    }
  });

  it('only CF_PAGES_ACCOUNT_ID set → auth_invalid naming CF_PAGES_API_TOKEN', async () => {
    const { ctx } = await createTestContext({ env: { CF_PAGES_ACCOUNT_ID: ACCT } });
    await expect(resolveCredentials(ctx)).rejects.toMatchObject({
      code: 'auth_invalid',
      message: expect.stringContaining('CF_PAGES_API_TOKEN'),
      hint: expect.stringContaining('CF_PAGES_API_TOKEN'),
    });
  });

  it('CLOUDFLARE_API_TOKEN alone is ignored → auth_required', async () => {
    const { ctx } = await createTestContext({
      env: { CLOUDFLARE_API_TOKEN: ENV_TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCT },
    });
    await expect(resolveCredentials(ctx)).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('not logged in → auth_required with a hint to run login in a terminal', async () => {
    const { ctx } = await createTestContext();
    const err = await resolveCredentials(ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'auth_required', hint: NOT_LOGGED_IN_HINT });
    expect((err as Error).message).toContain('CF_PAGES_API_TOKEN');
  });

  it('profile present but keyring entry missing → auth_required "Stored credentials are incomplete"', async () => {
    const { ctx } = await createTestContext({ ...(await loggedIn()), keyring: new Map() });
    await expect(resolveCredentials(ctx)).rejects.toMatchObject({
      code: 'auth_required',
      message: expect.stringContaining('Stored credentials are incomplete'),
      hint: expect.stringContaining('cf-pages login'),
    });
  });

  it('profile present but credentials.json has no entry → auth_required "Stored credentials are incomplete"', async () => {
    const { ctx } = await createTestContext(await loggedIn());
    await patchProfile(ctx.configDir, { storage: 'file' });
    await expect(resolveCredentials(ctx)).rejects.toMatchObject({
      code: 'auth_required',
      message: expect.stringContaining('Stored credentials are incomplete'),
    });
  });

  it('keyring storage reads the token from the keyring and carries the profile facts', async () => {
    const { ctx } = await createTestContext(await loggedIn());
    await patchProfile(ctx.configDir, { tokenExpiresOn: '2027-01-31T23:59:59Z' });
    const expected: Credentials = {
      token: TEST_TOKEN,
      accountId: ACCT,
      label: 'Acme',
      source: 'keyring',
      storage: 'keyring',
      tokenType: 'account',
      tokenExpiresOn: '2027-01-31T23:59:59Z',
    };
    await expect(resolveCredentials(ctx)).resolves.toEqual(expected);
  });

  it('storage file reads credentials.json and never opens the keyring', async () => {
    const { ctx } = await createTestContext(await loggedIn({ keyring: 'unavailable' }));
    await patchProfile(ctx.configDir, { storage: 'file' });
    await fileSecretStore(ctx.configDir).set(PROFILE, 'file-stored-token-abcdef0123456789');
    await expect(resolveCredentials(ctx)).resolves.toEqual({
      token: 'file-stored-token-abcdef0123456789',
      accountId: ACCT,
      label: 'Acme',
      source: 'file',
      storage: 'file',
      tokenType: 'account',
    });
  });

  it('keyring storage on a machine without a keyring → keyring_unavailable with the hint', async () => {
    const { ctx } = await createTestContext(await loggedIn({ keyring: 'unavailable' }));
    await expect(resolveCredentials(ctx)).rejects.toMatchObject({
      code: 'keyring_unavailable',
      hint: KEYRING_HINT,
    });
  });
});

describe('openKeyringStore (@napi-rs/keyring mocked: the real keychain is never touched)', () => {
  afterEach(() => {
    vi.doUnmock('@napi-rs/keyring');
    vi.resetModules();
  });

  type Call = { method: string; account: string; args: unknown[] };

  /** Installs a fake `@napi-rs/keyring` and loads a fresh keyring-store module on top of it. */
  async function load(behaviour: { getPassword?: (account: string, call: number) => Promise<string | null> } = {}) {
    const constructed: unknown[][] = [];
    const calls: Call[] = [];
    const secrets = new Map<string, string>();
    let gets = 0;
    class AsyncEntry {
      private readonly account: string;
      constructor(...args: unknown[]) {
        constructed.push(args);
        this.account = String(args[1]);
      }
      async getPassword(): Promise<string | null> {
        calls.push({ method: 'getPassword', account: this.account, args: [] });
        gets += 1;
        return behaviour.getPassword ? behaviour.getPassword(this.account, gets) : (secrets.get(this.account) ?? null);
      }
      async setPassword(password: string): Promise<void> {
        calls.push({ method: 'setPassword', account: this.account, args: [password] });
        secrets.set(this.account, password);
      }
      async deleteCredential(): Promise<boolean> {
        calls.push({ method: 'deleteCredential', account: this.account, args: [] });
        return secrets.delete(this.account);
      }
    }
    vi.resetModules();
    vi.doMock('@napi-rs/keyring', () => ({ AsyncEntry }));
    const mod = await import('../../src/core/credentials/keyring-store.js');
    return { openKeyringStore: mod.openKeyringStore, constructed, calls, secrets };
  }

  it('import failure → keyring_unavailable with the hint and the cause attached', async () => {
    vi.resetModules();
    vi.doMock('@napi-rs/keyring', () => {
      throw new Error('native binding missing');
    });
    const { openKeyringStore: open } = await import('../../src/core/credentials/keyring-store.js');
    const err = await open().catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'keyring_unavailable',
      message: 'No secure credential store is available on this system.',
      hint: KEYRING_HINT,
    });
    // Vitest wraps what a mock factory throws, so only the presence of the cause can be asserted.
    expect((err as Error).cause).toBeInstanceOf(Error);
  });

  it('a probe get(default) that rejects → keyring_unavailable with the hint', async () => {
    const { openKeyringStore: open, calls } = await load({
      getPassword: async () => {
        throw new Error('Cannot autolaunch D-Bus without X11 $DISPLAY');
      },
    });
    await expect(open()).rejects.toMatchObject({
      code: 'keyring_unavailable',
      message: 'No secure credential store is available on this system.',
      hint: KEYRING_HINT,
    });
    expect(calls).toEqual([{ method: 'getPassword', account: 'default', args: [] }]);
  });

  it('success: probes with get(default) and builds entries for service cf-pages on the secret service', async () => {
    const { openKeyringStore: open, constructed, calls } = await load();
    const store: SecretStore = await open();
    expect(store.kind).toBe('keyring');
    expect(constructed).toEqual([['cf-pages', 'default', { linux: { store: 'secret-service' } }]]);
    expect(calls).toEqual([{ method: 'getPassword', account: 'default', args: [] }]);
  });

  it('get, set and delete go through an entry for that account', async () => {
    const { openKeyringStore: open, constructed, secrets } = await load();
    const store = await open();
    await expect(store.get('default')).resolves.toBeNull();
    await store.set('default', TEST_TOKEN);
    expect(secrets.get('default')).toBe(TEST_TOKEN);
    await expect(store.get('default')).resolves.toBe(TEST_TOKEN);
    await expect(store.delete('default')).resolves.toBe(true);
    await expect(store.delete('default')).resolves.toBe(false);
    await expect(store.get('default')).resolves.toBeNull();
    for (const args of constructed) {
      expect(args).toEqual(['cf-pages', 'default', { linux: { store: 'secret-service' } }]);
    }

    await store.set('other', 'second-token');
    expect(constructed.at(-1)).toEqual(['cf-pages', 'other', { linux: { store: 'secret-service' } }]);
  });

  it('a failure after the probe (a locked keychain) is also keyring_unavailable', async () => {
    const { openKeyringStore: open } = await load({
      getPassword: async (_account, call) => {
        if (call === 1) return null;
        throw new Error('User interaction is not allowed.');
      },
    });
    const store = await open();
    await expect(store.get('default')).rejects.toMatchObject({ code: 'keyring_unavailable', hint: KEYRING_HINT });
  });
});

describe('createSession', () => {
  it('exposes ctx, flags and a single output', async () => {
    const { ctx } = await createTestContext();
    const f = flags();
    const session = createSession(ctx, f);
    expect(session.ctx).toBe(ctx);
    expect(session.flags).toBe(f);
    session.out.note('hello');
    expect(typeof session.credentials).toBe('function');
  });

  it('credentials() resolves once: the keyring is opened a single time, even for concurrent calls', async () => {
    const { ctx } = await createTestContext(await loggedIn());
    const open = vi.spyOn(ctx, 'openKeyring');
    const session = createSession(ctx, flags());
    const [a, b] = await Promise.all([session.credentials(), session.credentials()]);
    const c = await session.credentials();
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('credentials() rethrows the same failure on every call', async () => {
    const { ctx } = await createTestContext();
    const session = createSession(ctx, flags());
    await expect(session.credentials()).rejects.toMatchObject({ code: 'auth_required' });
    await expect(session.credentials()).rejects.toMatchObject({ code: 'auth_required' });
  });

  it('resolved token is registered in the redactor', async () => {
    const { ctx } = await createTestContext({ env: ENV });
    expect(ctx.redactor.apply(`token ${ENV_TOKEN}`)).toContain(ENV_TOKEN);
    await createSession(ctx, flags()).credentials();
    expect(ctx.redactor.apply(ENV_TOKEN)).toBe('[redacted]');
    expect(ctx.redactor.apply(`oops ${ENV_TOKEN} leaked`)).toBe('oops [redacted] leaked');
  });

  it('the stored token is registered too', async () => {
    const { ctx } = await createTestContext(await loggedIn());
    await createSession(ctx, flags()).credentials();
    expect(ctx.redactor.apply(TEST_TOKEN)).toBe('[redacted]');
  });

  it('credentials() emits the account header once (stderr, human mode)', async () => {
    const { ctx, io } = await createTestContext(await loggedIn());
    const session = createSession(ctx, flags());
    await session.credentials();
    await session.credentials();
    const header = `Acme · account …${ACCT.slice(-7)}\n`;
    expect(io.err).toBe(header);
    expect(io.out).toBe('');
  });

  it('credentials() puts the account in the --json document, never in a stderr line', async () => {
    const { ctx, io } = await createTestContext(await loggedIn());
    const session = createSession(ctx, flags({ json: true }));
    await session.credentials();
    await session.credentials();
    session.out.data({ n: 1 }, () => 'n');
    expect(io.err).toBe('');
    expect(JSON.parse(io.out)).toEqual({ ok: true, account: { label: 'Acme', accountId: ACCT }, data: { n: 1 } });
  });

  it('does not emit a header when credentials cannot be resolved', async () => {
    const { ctx, io } = await createTestContext();
    await createSession(ctx, flags())
      .credentials()
      .catch(() => {});
    expect(io.err).toBe('');
  });

  describe('expiry warning', () => {
    const NOW = new Date('2026-10-21T12:00:00.000Z');
    const DAY = 24 * 60 * 60 * 1000;

    async function sessionExpiringIn(ms: number | undefined, format: 'iso' | 'date' = 'iso') {
      const opts = await loggedIn({ now: NOW });
      const { ctx, io } = await createTestContext(opts);
      if (ms !== undefined) {
        const at = new Date(NOW.getTime() + ms).toISOString();
        await patchProfile(ctx.configDir, { tokenExpiresOn: format === 'iso' ? at : at.slice(0, 10) });
      }
      const session = createSession(ctx, flags());
      await session.credentials();
      return io.err;
    }

    it('warns when the token expires within 7 days', async () => {
      const err = await sessionExpiringIn(3 * DAY);
      expect(err).toContain('Warning: API token expires on 2026-10-24.\n');
    });

    it('warns at 7 days and not at 8', async () => {
      expect(await sessionExpiringIn(7 * DAY)).toContain('Warning: API token expires on 2026-10-28.\n');
      expect(await sessionExpiringIn(8 * DAY)).not.toContain('expires');
    });

    it('works with a date-only expiry', async () => {
      expect(await sessionExpiringIn(6 * DAY, 'date')).toContain('Warning: API token expires on 2026-10-27.\n');
      expect(await sessionExpiringIn(9 * DAY, 'date')).not.toContain('expires');
    });

    it('says "expired" for a token that is already past its date', async () => {
      const err = await sessionExpiringIn(-2 * DAY);
      expect(err).toContain('Warning: API token expired on 2026-10-19.\n');
      expect(err).not.toContain('expires');
    });

    it('is silent without an expiry date', async () => {
      expect(await sessionExpiringIn(undefined)).not.toContain('Warning');
    });

    it('ignores an expiry it cannot parse', async () => {
      const { ctx, io } = await createTestContext(await loggedIn({ now: NOW }));
      await patchProfile(ctx.configDir, { tokenExpiresOn: 'someday' });
      await createSession(ctx, flags()).credentials();
      expect(io.err).not.toContain('Warning');
    });

    it('warns once, however many times credentials() is called', async () => {
      const { ctx, io } = await createTestContext(await loggedIn({ now: NOW }));
      await patchProfile(ctx.configDir, { tokenExpiresOn: new Date(NOW.getTime() + DAY).toISOString() });
      const session = createSession(ctx, flags());
      await session.credentials();
      await session.credentials();
      expect(io.err.match(/expires on/g)).toHaveLength(1);
    });
  });

  describe('settings() and confirm()', () => {
    it('settings() reads the stored settings', async () => {
      const { ctx } = await createTestContext();
      await writeConfig(ctx.configDir, {
        version: 1,
        profiles: {},
        settings: { productionRequiresTty: true },
      });
      await expect(createSession(ctx, flags()).settings()).resolves.toEqual({ productionRequiresTty: true });
    });

    it('settings() on a fresh install is the defaults', async () => {
      const { ctx } = await createTestContext();
      await expect(createSession(ctx, flags()).settings()).resolves.toEqual({ productionRequiresTty: false });
    });

    it('confirm() applies confirmMutation with the stored settings', async () => {
      const { ctx } = await createTestContext();
      await writeConfig(ctx.configDir, { version: 1, profiles: {}, settings: { productionRequiresTty: true } });
      const req = { level: 'production', project: 'my-site', action: 'Redeploy main' } as const;
      const session = createSession(ctx, flags({ confirm: 'my-site' }));
      // --confirm would normally be enough, but the stored setting wants a person at a terminal.
      await expect(session.confirm(req)).rejects.toMatchObject({ code: 'confirmation_required' });
    });

    it('confirm() resolves when the flags allow the mutation', async () => {
      const { ctx } = await createTestContext();
      const session = createSession(ctx, flags({ confirm: 'my-site' }));
      await expect(
        session.confirm({ level: 'production', project: 'my-site', action: 'Redeploy main' }),
      ).resolves.toBeUndefined();
      await expect(
        createSession(ctx, flags({ yes: true })).confirm({ level: 'preview', project: 'my-site', action: 'Retry' }),
      ).resolves.toBeUndefined();
    });

    it('confirm() refuses without flags or a prompt', async () => {
      const { ctx } = await createTestContext();
      await expect(
        createSession(ctx, flags()).confirm({ level: 'production', project: 'my-site', action: 'Redeploy main' }),
      ).rejects.toMatchObject({ code: 'confirmation_required' });
    });
  });

  describe('audit()', () => {
    const NOW = new Date('2026-10-21T12:00:00.000Z');

    async function auditLines(dir: string): Promise<Record<string, unknown>[]> {
      const text = await readFile(join(dir, AUDIT_FILE), 'utf8');
      return text
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
    }

    it('fills ts and credentialSource (keyring)', async () => {
      const { ctx } = await createTestContext(await loggedIn({ now: NOW }));
      const session = createSession(ctx, flags());
      await session.credentials();
      await session.audit({ command: 'env set', project: 'my-site', env: 'preview', keys: ['API_URL'], result: 'ok' });
      expect(await auditLines(ctx.configDir)).toEqual([
        {
          ts: '2026-10-21T12:00:00.000Z',
          command: 'env set',
          project: 'my-site',
          env: 'preview',
          keys: ['API_URL'],
          result: 'ok',
          credentialSource: 'keyring',
        },
      ]);
    });

    it('uses the env source when the credentials came from env vars', async () => {
      const { ctx } = await createTestContext({ env: ENV, now: NOW });
      const session = createSession(ctx, flags());
      await session.audit({ command: 'redeploy', project: 'my-site', result: 'error', errorCode: 'api_error' });
      expect(await auditLines(ctx.configDir)).toEqual([
        {
          ts: '2026-10-21T12:00:00.000Z',
          command: 'redeploy',
          project: 'my-site',
          result: 'error',
          errorCode: 'api_error',
          credentialSource: 'env',
        },
      ]);
    });

    it('timestamps come from ctx.now(), so they follow the virtual clock', async () => {
      const { ctx } = await createTestContext(await loggedIn({ now: NOW }));
      const session = createSession(ctx, flags());
      await session.audit({ command: 'a', result: 'ok' });
      await ctx.sleep(60_000);
      await session.audit({ command: 'b', result: 'ok' });
      const lines = await auditLines(ctx.configDir);
      expect(lines.map((line) => line.ts)).toEqual(['2026-10-21T12:00:00.000Z', '2026-10-21T12:01:00.000Z']);
    });

    it('omits credentialSource when there are no credentials, and does not throw', async () => {
      const { ctx, io } = await createTestContext({ now: NOW });
      await createSession(ctx, flags()).audit({ command: 'x', result: 'error', errorCode: 'auth_required' });
      const [line] = await auditLines(ctx.configDir);
      expect(line).toEqual({
        ts: '2026-10-21T12:00:00.000Z',
        command: 'x',
        result: 'error',
        errorCode: 'auth_required',
      });
      expect(io.err).toBe('');
    });

    it('a failing audit log only warns', async () => {
      const { ctx, io } = await createTestContext(await loggedIn({ now: NOW }));
      // A directory where the log should be makes every append fail, on every platform.
      await mkdir(join(ctx.configDir, AUDIT_FILE));
      const session = createSession(ctx, flags());
      await session.credentials();
      await expect(session.audit({ command: 'env set', result: 'ok' })).resolves.toBeUndefined();
      expect(io.err).toContain('Warning: Could not write to the audit log');
      expect(io.err).toContain(join(ctx.configDir, AUDIT_FILE));
    });
  });
});
