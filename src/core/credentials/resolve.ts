import { readConfig } from '../config/store.js';
import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { fileSecretStore } from './file-store.js';
import { type Credentials, PROFILE } from './types.js';

/** Label for credentials that come from env vars and do not match the stored profile. */
const ENV_LABEL = 'environment';

/** An env var counts as set when it holds more than whitespace: CI secrets often end in a newline. */
function readEnv(ctx: Context, name: string): string | undefined {
  return ctx.env[name]?.trim() || undefined;
}

function incompleteEnv(present: string, missing: string): CliError {
  return new CliError('auth_invalid', `${present} is set but ${missing} is not: both are required together.`, {
    hint: `Set ${missing} as well, or unset ${present} to use the stored login.`,
    details: { missing },
  });
}

/**
 * Decides which credentials a command runs with.
 *
 * 1. `CF_PAGES_API_TOKEN` + `CF_PAGES_ACCOUNT_ID` win over anything stored. Both are required: one alone is an
 *    `auth_invalid` error rather than a silent fallback to the stored login. `CLOUDFLARE_API_TOKEN` is never read,
 *    so nobody uses Wrangler's token by accident.
 * 2. Otherwise the stored `default` profile, with the token read from the store it names (keyring or file).
 * 3. Otherwise `auth_required`.
 */
export async function resolveCredentials(ctx: Context): Promise<Credentials> {
  const envToken = readEnv(ctx, 'CF_PAGES_API_TOKEN');
  const envAccountId = readEnv(ctx, 'CF_PAGES_ACCOUNT_ID');

  if (envToken !== undefined && envAccountId === undefined)
    throw incompleteEnv('CF_PAGES_API_TOKEN', 'CF_PAGES_ACCOUNT_ID');
  if (envAccountId !== undefined && envToken === undefined)
    throw incompleteEnv('CF_PAGES_ACCOUNT_ID', 'CF_PAGES_API_TOKEN');

  const profile = (await readConfig(ctx.configDir)).profiles.default;

  if (envToken !== undefined && envAccountId !== undefined) {
    // The profile's label is only right when the env vars point at the same account.
    const label = profile?.accountId === envAccountId ? profile.label : ENV_LABEL;
    return { token: envToken, accountId: envAccountId, label, source: 'env' };
  }

  if (profile === undefined) {
    throw new CliError(
      'auth_required',
      'Not logged in: there is no stored login, and CF_PAGES_API_TOKEN and CF_PAGES_ACCOUNT_ID are not set.',
      { hint: 'Run `cf-pages login` in your terminal.' },
    );
  }

  const store = profile.storage === 'keyring' ? await ctx.openKeyring() : fileSecretStore(ctx.configDir);
  const token = await store.get(PROFILE);
  if (token === null) {
    const where = profile.storage === 'keyring' ? 'the keyring' : 'credentials.json';
    throw new CliError(
      'auth_required',
      `Stored credentials are incomplete: the login for "${profile.label}" exists, but its API token is not in ${where}.`,
      { hint: 'Run `cf-pages login` in your terminal to store the token again.' },
    );
  }

  return {
    token,
    accountId: profile.accountId,
    label: profile.label,
    source: profile.storage,
    storage: profile.storage,
    tokenType: profile.tokenType,
    ...(profile.tokenExpiresOn === undefined ? {} : { tokenExpiresOn: profile.tokenExpiresOn }),
  };
}
