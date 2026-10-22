import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIALS_FILE, fileSecretStore } from '../../src/core/credentials/file-store.js';
import { CliError } from '../../src/core/errors.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cf-pages-file-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const TOKEN = 'cfat_test_token_value_1234567890';

describe('fileSecretStore', () => {
  it('is the "file" kind and keeps tokens in credentials.json', () => {
    expect(fileSecretStore(dir).kind).toBe('file');
    expect(CREDENTIALS_FILE).toBe('credentials.json');
  });

  it('get on a fresh install is null and creates nothing', async () => {
    const store = fileSecretStore(join(dir, 'nested'));
    await expect(store.get('default')).resolves.toBeNull();
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('stores { "<account>": "<token>" } and reads it back', async () => {
    const store = fileSecretStore(dir);
    await store.set('default', TOKEN);
    expect(JSON.parse(await readFile(join(dir, CREDENTIALS_FILE), 'utf8'))).toEqual({ default: TOKEN });
    await expect(store.get('default')).resolves.toBe(TOKEN);
    await expect(fileSecretStore(dir).get('default')).resolves.toBe(TOKEN);
  });

  it('set replaces the token of that account and keeps the others', async () => {
    const store = fileSecretStore(dir);
    await store.set('default', TOKEN);
    await store.set('other', 'second-token');
    await store.set('default', 'cfat_replacement_token_0987654321');
    expect(JSON.parse(await readFile(join(dir, CREDENTIALS_FILE), 'utf8'))).toEqual({
      default: 'cfat_replacement_token_0987654321',
      other: 'second-token',
    });
  });

  it('get of an unknown account is null, including names that exist on every object', async () => {
    const store = fileSecretStore(dir);
    await store.set('default', TOKEN);
    await expect(store.get('other')).resolves.toBeNull();
    await expect(store.get('toString')).resolves.toBeNull();
    await expect(store.get('__proto__')).resolves.toBeNull();
  });

  it('ignores entries that are not strings', async () => {
    await writeFile(join(dir, CREDENTIALS_FILE), JSON.stringify({ default: 42, other: 'ok-token-value' }));
    const store = fileSecretStore(dir);
    await expect(store.get('default')).resolves.toBeNull();
    await expect(store.get('other')).resolves.toBe('ok-token-value');
  });

  it('delete reports whether the account existed', async () => {
    const store = fileSecretStore(dir);
    await store.set('default', TOKEN);
    await store.set('other', 'second-token');
    await expect(store.delete('default')).resolves.toBe(true);
    await expect(store.delete('default')).resolves.toBe(false);
    await expect(store.get('default')).resolves.toBeNull();
    await expect(store.get('other')).resolves.toBe('second-token');
  });

  it('deleting the last token removes the file', async () => {
    const store = fileSecretStore(dir);
    await store.set('default', TOKEN);
    await expect(store.delete('default')).resolves.toBe(true);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it('delete on a fresh install is false and creates nothing', async () => {
    await expect(fileSecretStore(join(dir, 'nested')).delete('default')).resolves.toBe(false);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  posixOnly('writes the file with 0600 and creates the directory with 0700', async () => {
    const nested = join(dir, 'cf-pages');
    await fileSecretStore(nested).set('default', TOKEN);
    expect((await stat(join(nested, CREDENTIALS_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  posixOnly('rewriting keeps the file at 0600', async () => {
    const store = fileSecretStore(dir);
    await store.set('default', TOKEN);
    await store.set('other', 'second-token');
    expect((await stat(join(dir, CREDENTIALS_FILE))).mode & 0o777).toBe(0o600);
  });

  it('leaves no temporary files behind', async () => {
    const store = fileSecretStore(dir);
    await store.set('default', TOKEN);
    await store.set('other', 'second-token');
    await expect(readdir(dir)).resolves.toEqual([CREDENTIALS_FILE]);
  });

  it('a file that is not valid JSON → CliError naming the path, never the content', async () => {
    const path = join(dir, CREDENTIALS_FILE);
    await writeFile(path, `{ "default": "${TOKEN}`);
    const store = fileSecretStore(dir);
    for (const run of [() => store.get('default'), () => store.set('default', TOKEN), () => store.delete('default')]) {
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      const { code, message, hint } = err as CliError;
      expect(code).toBe('unexpected');
      expect(hint).toContain(path);
      expect(`${message} ${hint}`).not.toContain(TOKEN);
      expect((err as CliError).cause).toBeUndefined();
    }
    // Refusing to touch it means a failed set never destroys what is there.
    expect(await readFile(path, 'utf8')).toBe(`{ "default": "${TOKEN}`);
  });

  it('a file that is JSON but not an object → CliError', async () => {
    for (const text of ['[]', '"x"', 'null', '7']) {
      await writeFile(join(dir, CREDENTIALS_FILE), text);
      await expect(fileSecretStore(dir).get('default')).rejects.toBeInstanceOf(CliError);
    }
  });

  it('a directory in the way is an unexpected error, not "not logged in"', async () => {
    await mkdir(join(dir, CREDENTIALS_FILE));
    await expect(fileSecretStore(dir).get('default')).rejects.toThrow();
  });
});
