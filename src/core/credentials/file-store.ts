import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError } from '../errors.js';
import { writePrivateFile } from '../private-file.js';
import type { SecretStore } from './types.js';

export const CREDENTIALS_FILE = 'credentials.json';

/**
 * Insecure fallback for machines without a keychain: tokens in plain text in `credentials.json`, shaped
 * `{ "<account>": "<token>" }`, with 0600 permissions. Only `login --insecure-storage` chooses it.
 */
export function fileSecretStore(dir: string): SecretStore {
  const path = join(dir, CREDENTIALS_FILE);

  // The message never quotes the file: it holds secrets.
  const corrupt = (problem: string, cause?: unknown) =>
    new CliError('unexpected', `The credentials file is invalid: ${problem}.`, {
      hint: `Delete ${path} and run \`cf-pages login\` again, or use CF_PAGES_API_TOKEN and CF_PAGES_ACCOUNT_ID.`,
      details: { path },
      ...(cause === undefined ? {} : { cause }),
    });

  async function load(): Promise<Map<string, string>> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return new Map();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw corrupt('it is not valid JSON', cause);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw corrupt('expected a JSON object');
    }
    return new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }

  const save = (secrets: Map<string, string>) =>
    writePrivateFile(dir, CREDENTIALS_FILE, `${JSON.stringify(Object.fromEntries(secrets), null, 2)}\n`);

  return {
    kind: 'file',
    async get(account) {
      return (await load()).get(account) ?? null;
    },
    async set(account, secret) {
      const secrets = await load();
      secrets.set(account, secret);
      await save(secrets);
    },
    async delete(account) {
      const secrets = await load();
      if (!secrets.delete(account)) return false;
      // No token left: remove the file rather than leave an empty credentials file around.
      await (secrets.size === 0 ? rm(path, { force: true }) : save(secrets));
      return true;
    },
  };
}
