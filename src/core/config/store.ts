import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from '../confirm.js';
import { CliError } from '../errors.js';
import { writePrivateFile } from '../private-file.js';

export const CONFIG_FILE = 'config.json';

/** Non-secret facts about the stored login. The token itself lives in the keyring or in `credentials.json`. */
export interface ProfileConfig {
  label: string;
  accountId: string;
  storage: 'keyring' | 'file';
  tokenType: 'user' | 'account';
  tokenExpiresOn?: string;
  createdAt: string;
}

export interface ConfigFile {
  version: 1;
  profiles: { default?: ProfileConfig };
  settings: Settings;
}

function defaultConfig(): ConfigFile {
  return { version: 1, profiles: {}, settings: { productionRequiresTty: false } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProfile(value: unknown): value is ProfileConfig {
  return (
    isRecord(value) &&
    typeof value.label === 'string' &&
    typeof value.accountId === 'string' &&
    (value.storage === 'keyring' || value.storage === 'file') &&
    (value.tokenType === 'user' || value.tokenType === 'account') &&
    (value.tokenExpiresOn === undefined || typeof value.tokenExpiresOn === 'string') &&
    typeof value.createdAt === 'string'
  );
}

function corrupt(path: string, problem: string, cause?: unknown): CliError {
  return new CliError('unexpected', `The configuration file is invalid: ${problem}.`, {
    hint: `Fix or delete ${path}, then run the command again. Deleting it removes the saved login and settings.`,
    details: { path },
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Checks the parsed JSON and fills in what is missing. Anything the file holds beyond the known fields is dropped. */
function parseConfig(path: string, parsed: unknown): ConfigFile {
  if (!isRecord(parsed)) throw corrupt(path, 'expected a JSON object');
  if (parsed.version !== 1) throw corrupt(path, `unsupported version ${JSON.stringify(parsed.version) ?? 'missing'}`);

  const config = defaultConfig();

  if (parsed.profiles !== undefined) {
    if (!isRecord(parsed.profiles)) throw corrupt(path, '"profiles" must be an object');
    if (parsed.profiles.default !== undefined) {
      if (!isProfile(parsed.profiles.default)) throw corrupt(path, '"profiles.default" is malformed');
      config.profiles.default = parsed.profiles.default;
    }
  }

  if (parsed.settings !== undefined) {
    if (!isRecord(parsed.settings)) throw corrupt(path, '"settings" must be an object');
    const { productionRequiresTty } = parsed.settings;
    if (productionRequiresTty !== undefined) {
      if (typeof productionRequiresTty !== 'boolean') {
        throw corrupt(path, '"settings.productionRequiresTty" must be true or false');
      }
      config.settings.productionRequiresTty = productionRequiresTty;
    }
  }

  return config;
}

/** Reads `config.json`. A missing file is a fresh install: every call gets its own copy of the defaults. */
export async function readConfig(dir: string): Promise<ConfigFile> {
  const path = join(dir, CONFIG_FILE);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return defaultConfig();
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw corrupt(path, 'it is not valid JSON', err);
  }
  return parseConfig(path, parsed);
}

/** Writes `config.json` atomically and privately (directory 0700, file 0600): see `writePrivateFile`. */
export async function writeConfig(dir: string, cfg: ConfigFile): Promise<void> {
  await writePrivateFile(dir, CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
}
