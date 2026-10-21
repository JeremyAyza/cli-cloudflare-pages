import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_FILE, type ConfigFile, readConfig, writeConfig } from '../../src/core/config/store.js';
import { CliError } from '../../src/core/errors.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cf-pages-config-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const withProfile: ConfigFile = {
  version: 1,
  profiles: {
    default: {
      label: 'Acme',
      accountId: '0123456789abcdef0123456789abcdef',
      storage: 'keyring',
      tokenType: 'user',
      tokenExpiresOn: '2027-01-01T00:00:00Z',
      createdAt: '2026-10-21T12:00:00.000Z',
    },
  },
  settings: { productionRequiresTty: true },
};

async function failure(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CliError) return err;
    throw err;
  }
  throw new Error('Expected the promise to reject with a CliError.');
}

describe('readConfig', () => {
  it('missing config returns defaults', async () => {
    expect(await readConfig(dir)).toEqual({ version: 1, profiles: {}, settings: { productionRequiresTty: false } });
  });

  it('a missing config directory also returns defaults, and creates nothing', async () => {
    const missing = join(dir, 'does', 'not', 'exist');
    expect((await readConfig(missing)).settings).toEqual({ productionRequiresTty: false });
    await expect(stat(missing)).rejects.toThrow();
  });

  it('every call returns its own copy of the defaults', async () => {
    const first = await readConfig(dir);
    first.settings.productionRequiresTty = true;
    first.profiles.default = withProfile.profiles.default;
    expect(await readConfig(dir)).toEqual({ version: 1, profiles: {}, settings: { productionRequiresTty: false } });
  });

  it('corrupt JSON → CliError unexpected with the file path in the hint', async () => {
    await writeFile(join(dir, CONFIG_FILE), '{ "version": 1, ');
    const err = await failure(readConfig(dir));
    expect(err.code).toBe('unexpected');
    expect(err.exitCode).toBe(1);
    expect(err.hint).toContain(join(dir, CONFIG_FILE));
  });

  it.each([
    ['not an object', '[]'],
    ['null', 'null'],
    ['an unknown version', JSON.stringify({ version: 2, profiles: {}, settings: { productionRequiresTty: false } })],
    ['a non-boolean setting', JSON.stringify({ version: 1, profiles: {}, settings: { productionRequiresTty: 'no' } })],
    ['a malformed profile', JSON.stringify({ version: 1, profiles: { default: { label: 7 } }, settings: {} })],
  ])('valid JSON with the wrong shape (%s) is reported as corrupt', async (_name, text) => {
    await writeFile(join(dir, CONFIG_FILE), text);
    const err = await failure(readConfig(dir));
    expect(err.code).toBe('unexpected');
    expect(err.hint).toContain(join(dir, CONFIG_FILE));
  });

  it('fills in missing sections with defaults', async () => {
    await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ version: 1 }));
    expect(await readConfig(dir)).toEqual({ version: 1, profiles: {}, settings: { productionRequiresTty: false } });
  });
});

describe('writeConfig', () => {
  it('write → read roundtrip', async () => {
    await writeConfig(dir, withProfile);
    expect(await readConfig(dir)).toEqual(withProfile);
  });

  it('writes pretty JSON with a trailing newline, and leaves no temporary file behind', async () => {
    await writeConfig(dir, withProfile);
    const text = await readFile(join(dir, CONFIG_FILE), 'utf8');
    expect(text).toBe(`${JSON.stringify(withProfile, null, 2)}\n`);
    expect(await readdir(dir)).toEqual([CONFIG_FILE]);
  });

  it('replaces an existing config', async () => {
    await writeConfig(dir, withProfile);
    await writeConfig(dir, { version: 1, profiles: {}, settings: { productionRequiresTty: false } });
    expect(await readConfig(dir)).toEqual({ version: 1, profiles: {}, settings: { productionRequiresTty: false } });
    expect(await readdir(dir)).toEqual([CONFIG_FILE]);
  });

  posixOnly('creates the directory with 0700 and the file with 0600', async () => {
    const nested = join(dir, 'cf-pages');
    await writeConfig(nested, withProfile);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
    expect((await stat(join(nested, CONFIG_FILE))).mode & 0o777).toBe(0o600);
  });

  posixOnly('keeps the file at 0600 when it replaces an existing one', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, CONFIG_FILE), '{}', { mode: 0o644 });
    await writeConfig(dir, withProfile);
    expect((await stat(join(dir, CONFIG_FILE))).mode & 0o777).toBe(0o600);
  });

  it('an unwritable directory rejects and leaves the previous config intact', async () => {
    await writeConfig(dir, withProfile);
    const blocker = join(dir, CONFIG_FILE, 'inside');
    await expect(writeConfig(blocker, withProfile)).rejects.toThrow();
    expect(await readConfig(dir)).toEqual(withProfile);
  });
});
