import { join } from 'node:path';
import { type Command, Option } from '@commander-js/extra-typings';
import { appendAuditOrWarn } from '../core/audit.js';
import { type ProfileConfig, readConfig, writeConfig } from '../core/config/store.js';
import { canPrompt } from '../core/confirm.js';
import type { Context } from '../core/context.js';
import { CREDENTIALS_FILE, fileSecretStore } from '../core/credentials/file-store.js';
import { classifyToken, type TokenKind, type TokenVerification, verifyToken } from '../core/credentials/token.js';
import {
  type CredentialSource,
  type Credentials,
  KEYRING_SERVICE,
  PROFILE,
  type SecretStore,
} from '../core/credentials/types.js';
import { CliError } from '../core/errors.js';
import { type GlobalFlags, readGlobalFlags } from '../core/flags.js';
import { API_TOKENS_URL, ApiClient } from '../core/http/client.js';
import { createOutput, type Output } from '../core/output.js';
import { createSession } from '../core/session.js';
import { PagesApi } from '../providers/pages/api.js';

const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_LABEL_LENGTH = 64;

const GUIDANCE = `Create a token at ${API_TOKENS_URL} (or an account-owned token under Manage Account → Account API Tokens) with the permission: Account · Cloudflare Pages · Edit.`;
const ACCOUNT_ID_HELP =
  'Your Account ID is the 32-character code in the dashboard URL: https://dash.cloudflare.com/<account id>/…';
const NOT_A_PERSON =
  'Login needs a person at a terminal. Run `cf-pages login` in your own terminal (or pipe the token with --token-stdin).';
const WRITE_PERMISSION_NOTE =
  "Cloudflare Pages · Edit can't be verified until the first change. Only read access was checked, so a redeploy or `env set` can still be refused with a permission error.";
const ACCOUNT_ID_HINT =
  'Copy the Account ID from the dashboard URL (https://dash.cloudflare.com/<account id>/…) or from the account overview page, and paste it exactly.';

type StorageKind = 'keyring' | 'file';

/** What `login`, `logout` and `whoami` call the place where the token lives. A plain-text file is always flagged. */
const storageLabel = (kind: StorageKind): string => (kind === 'file' ? 'file (insecure)' : 'keyring');

/** The API token is a secret from the moment it is read: from then on it is scrubbed from every message. */
function registerSecret(ctx: Context, secret: string): void {
  ctx.redactor.add(secret);
  // A value with whitespace inside is rejected later; its parts must not leak through the error either.
  for (const part of secret.split(/\s+/)) ctx.redactor.add(part);
}

function keyValueLines(rows: [string, string][]): string {
  const width = Math.max(...rows.map(([key]) => key.length)) + 2;
  return rows.map(([key, value]) => `${`${key}:`.padEnd(width)}${value}`).join('\n');
}

function envCredentialsSet(ctx: Context): boolean {
  return ['CF_PAGES_API_TOKEN', 'CF_PAGES_ACCOUNT_ID'].some((name) => ctx.env[name]?.trim());
}

// ---------------------------------------------------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------------------------------------------------

function labelProblem(ctx: Context, raw: string): string | undefined {
  const label = raw.trim();
  if (label === '') return 'The label cannot be empty.';
  const chars = [...label];
  if (chars.length > MAX_LABEL_LENGTH) return `The label can have at most ${MAX_LABEL_LENGTH} characters.`;
  if (chars.some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
    return 'The label cannot contain control characters or line breaks.';
  // The label is shown in every command's header: a token pasted here by mistake must not end up on screen or on disk.
  if (ctx.redactor.apply(label) !== label) return 'The label looks like an API token. Use a name such as "Acme".';
  return undefined;
}

function parseLabel(ctx: Context, raw: string): string {
  const problem = labelProblem(ctx, raw);
  if (problem !== undefined) {
    throw new CliError('usage', problem, { hint: 'Pass a short name with --label, for example --label Acme.' });
  }
  return raw.trim();
}

function accountIdProblem(raw: string): string | undefined {
  // The value is not echoed: a token pasted into the wrong field must stay out of the output.
  return ACCOUNT_ID_PATTERN.test(raw.trim())
    ? undefined
    : 'The Account ID must be 32 lowercase hexadecimal characters.';
}

function parseAccountId(raw: string): string {
  const problem = accountIdProblem(raw);
  if (problem !== undefined) throw new CliError('usage', problem, { hint: ACCOUNT_ID_HINT });
  return raw.trim();
}

function parseToken(ctx: Context, raw: string, fromStdin: boolean): string {
  const token = raw.trim();
  registerSecret(ctx, token);
  if (token === '') {
    throw new CliError('usage', 'The API token is empty.', {
      hint: fromStdin
        ? 'Pipe the token into the command, for example: printf %s "$TOKEN" | cf-pages login --token-stdin --label Acme --account-id <id>'
        : 'Run `cf-pages login` again and paste the token at the hidden prompt.',
    });
  }
  if (/\s/.test(token)) {
    throw new CliError('usage', 'The API token contains spaces or line breaks.', {
      hint: `Copy the token again as a single string, without spaces or line breaks. Manage tokens: ${API_TOKENS_URL}`,
    });
  }
  return token;
}

// ---------------------------------------------------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------------------------------------------------

interface LoginOptions {
  label?: string;
  accountId?: string;
  tokenStdin?: true;
  insecureStorage?: true;
}

/** Step 1: the place for the token, chosen and checked before anyone is asked anything. */
async function openStore(ctx: Context, out: Output, insecure: boolean): Promise<SecretStore> {
  if (!insecure) return ctx.openKeyring();
  out.warn(
    `--insecure-storage: the API token will be stored in plain text in ${join(ctx.configDir, CREDENTIALS_FILE)} (permissions 0600). Anyone who can read your files can use it. Prefer the OS keychain when one is available.`,
  );
  const store = fileSecretStore(ctx.configDir);
  // Reads the file once, so an unreadable or corrupt one fails now and not after the person typed everything.
  await store.get(PROFILE);
  return store;
}

/** Step 2: a saved login is only replaced on purpose. */
async function confirmReplace(
  ctx: Context,
  flags: GlobalFlags,
  interactive: boolean,
  previous: ProfileConfig,
): Promise<void> {
  if (flags.yes) return;
  if (!interactive) {
    throw new CliError(
      'confirmation_required',
      `A login for "${previous.label}" is already saved, and prompts are not available to confirm replacing it.`,
      { hint: 'Re-run with --yes to replace it, or run `cf-pages logout` first.' },
    );
  }
  if (!(await ctx.io.prompts.confirm(`Replace the saved login "${previous.label}"?`, { default: false }))) {
    throw new CliError('cancelled', 'Cancelled by the user.', {
      hint: 'Run `cf-pages login` again and answer yes to replace the saved login, or keep using it.',
    });
  }
}

interface LoginInput {
  label: string;
  accountId: string;
  token: string;
}

/** Step 3: label, Account ID and token, from flags, stdin or (only on a terminal) prompts. */
async function collectInput(
  ctx: Context,
  out: Output,
  interactive: boolean,
  opts: LoginOptions,
  given: { label: string | undefined; accountId: string | undefined },
): Promise<LoginInput> {
  const fromStdin = opts.tokenStdin === true;
  if (!fromStdin && !interactive) throw new CliError('auth_required', NOT_A_PERSON);

  if (!interactive) {
    const missing = [
      given.label === undefined ? '--label' : undefined,
      given.accountId === undefined ? '--account-id' : undefined,
    ];
    if (missing.some((flag) => flag !== undefined)) {
      throw new CliError(
        'usage',
        `${missing.filter(Boolean).join(' and ')} required when the token comes from stdin.`,
        {
          hint: `Prompts are not available, so pass them as flags: printf %s "$TOKEN" | cf-pages login --token-stdin --label Acme --account-id <id>. ${ACCOUNT_ID_HELP}`,
        },
      );
    }
  }

  if (interactive && !fromStdin) {
    out.note(GUIDANCE);
    if (given.accountId === undefined) out.note(ACCOUNT_ID_HELP);
  }

  const label =
    given.label ??
    parseLabel(
      ctx,
      await ctx.io.prompts.text('Label (a name to recognize these credentials, e.g. Acme)', {
        validate: (value) => labelProblem(ctx, value) ?? true,
      }),
    );
  const accountId =
    given.accountId ??
    parseAccountId(
      await ctx.io.prompts.text('Cloudflare Account ID', { validate: (value) => accountIdProblem(value) ?? true }),
    );
  const raw = fromStdin ? await ctx.io.readStdin() : await ctx.io.prompts.password('API token (input is hidden)');
  return { label, accountId, token: parseToken(ctx, raw, fromStdin) };
}

/** Steps 5 and 6 turn a vague 403 or 404 on the probe into advice about the two things the person typed. */
async function probePages(api: PagesApi): Promise<void> {
  try {
    await api.probe();
  } catch (err) {
    if (err instanceof CliError && (err.code === 'permission_denied' || err.code === 'not_found')) {
      throw new CliError(err.code, err.message, {
        hint: `Check that the Account ID belongs to the account the token was created for, and that the token has the permission Account · Cloudflare Pages · Edit (or Read) on it. Manage tokens: ${API_TOKENS_URL}`,
        ...(err.details === undefined ? {} : { details: err.details }),
        cause: err,
      });
    }
    throw err;
  }
}

/** The token of the login that was just replaced must not stay behind in the other store. */
async function removeStaleToken(ctx: Context, out: Output, from: StorageKind): Promise<void> {
  try {
    const store = from === 'keyring' ? await ctx.openKeyring() : fileSecretStore(ctx.configDir);
    await store.delete(PROFILE);
  } catch {
    out.warn(
      from === 'keyring'
        ? `The token of the previous login may still be in the OS keyring (service "${KEYRING_SERVICE}", account "${PROFILE}"). Remove it there if you do not need it.`
        : `The token of the previous login may still be in ${join(ctx.configDir, CREDENTIALS_FILE)}. Delete that file if you do not need it.`,
    );
  }
}

async function runLogin(ctx: Context, flags: GlobalFlags, opts: LoginOptions): Promise<void> {
  const out = createOutput(ctx.io, flags);
  const interactive = canPrompt(ctx.io, flags);

  // Values from flags are checked first: a typo should not cost a keychain access or a question.
  const given = {
    label: opts.label === undefined ? undefined : parseLabel(ctx, opts.label),
    accountId: opts.accountId === undefined ? undefined : parseAccountId(opts.accountId),
  };

  const store = await openStore(ctx, out, opts.insecureStorage === true);
  const previous = (await readConfig(ctx.configDir)).profiles.default;
  if (previous !== undefined && !flags.dryRun) await confirmReplace(ctx, flags, interactive, previous);

  const { label, accountId, token } = await collectInput(ctx, out, interactive, opts, given);

  const kind = classifyToken(token);
  if (kind === 'global_key') {
    throw new CliError(
      'usage',
      'Global API Keys are not supported: that kind of key has access to the whole account.',
      {
        hint: `Create an API token with the permission Account · Cloudflare Pages · Edit instead: ${API_TOKENS_URL}`,
      },
    );
  }

  const client = new ApiClient({
    token,
    userAgent: `cf-pages/${ctx.version}`,
    sleep: (ms) => ctx.sleep(ms),
    ...(flags.debug ? { debug: (line: string) => ctx.io.stderr(`${ctx.redactor.apply(line)}\n`) } : {}),
  });
  const verified = await verifyToken(client, accountId, kind);
  if (verified.status !== 'active') {
    throw new CliError('auth_invalid', `The API token is not active (status: ${verified.status}).`, {
      hint: `Create a new token with the permission Account · Cloudflare Pages · Edit, then run \`cf-pages login\` again. Manage tokens: ${API_TOKENS_URL}`,
      details: { status: verified.status },
    });
  }
  await probePages(new PagesApi(client, accountId));

  const storage = store.kind;
  const summary = {
    label,
    accountId,
    tokenType: verified.tokenType,
    storage: storageLabel(storage),
    expiresOn: verified.expiresOn ?? null,
  };
  const rows = (): [string, string][] => [
    ['Account', accountId],
    ['Token type', verified.tokenType],
    ['Storage', summary.storage],
    ['Expires', summary.expiresOn ?? 'never'],
  ];

  if (flags.dryRun) {
    out.data(
      { dryRun: true, ...summary },
      () => `Dry run: the token is valid and the account is reachable. Nothing was stored.\n${keyValueLines(rows())}`,
    );
    return;
  }

  await store.set(PROFILE, token);
  try {
    // Read again: the questions can take a while and `settings set` writes the same file.
    const config = await readConfig(ctx.configDir);
    const profile: ProfileConfig = {
      label,
      accountId,
      storage,
      tokenType: verified.tokenType,
      ...(verified.expiresOn === undefined ? {} : { tokenExpiresOn: verified.expiresOn }),
      createdAt: ctx.now().toISOString(),
    };
    await writeConfig(ctx.configDir, { ...config, profiles: { ...config.profiles, default: profile } });
  } catch (err) {
    // No profile means nothing would ever use (or delete) the token that was just saved.
    if (previous === undefined) await store.delete(PROFILE).catch(() => false);
    throw err;
  }
  if (previous !== undefined && previous.storage !== storage) await removeStaleToken(ctx, out, previous.storage);

  await appendAuditOrWarn(out, ctx.configDir, {
    ts: ctx.now().toISOString(),
    command: 'login',
    result: 'ok',
    credentialSource: storage,
  });

  out.data(summary, () => `Logged in as "${label}".\n${keyValueLines(rows())}`);
  out.note(WRITE_PERMISSION_NOTE);
  if (envCredentialsSet(ctx)) {
    out.note(
      'CF_PAGES_API_TOKEN / CF_PAGES_ACCOUNT_ID are set in this environment and take priority over the saved login. Unset them to use it.',
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------------------------------------------------

async function runLogout(ctx: Context, flags: GlobalFlags): Promise<void> {
  const out = createOutput(ctx.io, flags);
  const profile = (await readConfig(ctx.configDir)).profiles.default;
  const noteEnv = () => {
    if (envCredentialsSet(ctx)) {
      out.note(
        'CF_PAGES_API_TOKEN / CF_PAGES_ACCOUNT_ID are still set in this environment and keep working. Unset them to stop using that token.',
      );
    }
  };

  if (profile === undefined) {
    out.data({ loggedOut: false }, () => 'Already logged out.');
    noteEnv();
    return;
  }

  const removed = {
    label: profile.label,
    accountId: profile.accountId,
    storage: storageLabel(profile.storage),
  };
  if (flags.dryRun) {
    out.data(
      { dryRun: true, loggedOut: false, ...removed },
      () => `Dry run: would delete the saved token and the login "${profile.label}". Nothing changed.`,
    );
    return;
  }

  // The token goes first: if it cannot be deleted the login stays, and the person can try again.
  let tokenDeleted = false;
  let unreachable = false;
  try {
    const store = profile.storage === 'keyring' ? await ctx.openKeyring() : fileSecretStore(ctx.configDir);
    tokenDeleted = await store.delete(PROFILE);
  } catch (err) {
    if (!(err instanceof CliError && err.code === 'keyring_unavailable')) throw err;
    unreachable = true;
    // Nothing else can be done with a keychain that cannot be opened; keeping the login would only trap the person.
    out.warn(
      `The OS keyring could not be reached, so the saved token may still be in it (service "${KEYRING_SERVICE}", account "${PROFILE}"). Remove it there if you do not need it.`,
    );
  }

  const latest = await readConfig(ctx.configDir);
  const { default: _removed, ...otherProfiles } = latest.profiles;
  await writeConfig(ctx.configDir, { ...latest, profiles: otherProfiles });

  await appendAuditOrWarn(out, ctx.configDir, {
    ts: ctx.now().toISOString(),
    command: 'logout',
    result: 'ok',
    credentialSource: profile.storage,
  });

  const tokenOutcome = tokenDeleted
    ? 'The saved token was deleted.'
    : unreachable
      ? 'The saved token could not be deleted (see the warning above).'
      : 'No saved token was found to delete.';
  out.data({ loggedOut: true, ...removed, tokenDeleted }, () => `Logged out of "${profile.label}". ${tokenOutcome}`);
  noteEnv();
}

// ---------------------------------------------------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------------------------------------------------

interface Identity {
  label: string;
  accountId: string;
  tokenType: 'user' | 'account' | null;
  source: CredentialSource;
  storage: string | null;
  expiresOn: string | null;
  status: string;
}

function renderIdentity(i: Identity): string {
  return keyValueLines([
    ['Label', i.label],
    ['Account', i.accountId],
    ['Token type', i.tokenType ?? 'unknown'],
    ['Source', i.source === 'env' ? 'environment variables' : 'saved login'],
    ['Storage', i.storage ?? 'none (environment variables)'],
    ['Expires', i.expiresOn ?? 'never'],
    ['Status', i.status === 'rejected' ? 'rejected (Cloudflare does not accept this token)' : i.status],
  ]);
}

/** A stored login knows its token type; for env credentials the prefix says it, and an unprefixed token is probed. */
function expectedKind(creds: Credentials): Exclude<TokenKind, 'global_key'> {
  if (creds.tokenType !== undefined) return creds.tokenType;
  const guess = classifyToken(creds.token);
  return guess === 'global_key' ? 'unknown' : guess;
}

async function runWhoami(ctx: Context, flags: GlobalFlags): Promise<void> {
  const session = createSession(ctx, flags);
  const creds = await session.credentials();
  const known = {
    label: creds.label,
    accountId: creds.accountId,
    tokenType: creds.tokenType ?? null,
    source: creds.source,
    storage: creds.storage === undefined ? null : storageLabel(creds.storage),
    expiresOn: creds.tokenExpiresOn ?? null,
  };

  let verified: TokenVerification;
  try {
    verified = await verifyToken(await session.client(), creds.accountId, expectedKind(creds));
  } catch (err) {
    if (!(err instanceof CliError) || (err.code !== 'auth_invalid' && err.code !== 'permission_denied')) throw err;
    // Print what is known (the person wants to see which login is broken), then fail like any rejected token.
    const identity: Identity = { ...known, status: 'rejected' };
    if (!flags.json) session.out.data(identity, renderIdentity);
    throw new CliError(err.code, err.message, {
      ...(err.hint === undefined ? {} : { hint: err.hint }),
      details: { ...err.details, identity },
      cause: err,
    });
  }

  if (verified.status !== 'active') session.out.warn(`The API token is ${verified.status}, not active.`);
  const identity: Identity = {
    ...known,
    tokenType: verified.tokenType,
    expiresOn: verified.expiresOn ?? null,
    status: verified.status,
  };
  session.out.data(identity, renderIdentity);
}

// ---------------------------------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------------------------------

/** Registers `login`, `logout` and `whoami`. */
export function registerAuth(program: Command, ctx: Context): void {
  program
    .command('login')
    .description('Check an API token and save it for the other commands')
    .option('--label <label>', 'name to recognize these credentials, for example Acme')
    .option('--account-id <id>', 'Cloudflare Account ID (32 hexadecimal characters)')
    .option('--token-stdin', 'read the API token from stdin instead of asking for it')
    .option('--insecure-storage', 'keep the token in a plain-text 0600 file when there is no OS keychain')
    // Never advertised and never accepted: it exists to explain why, instead of commander echoing the value back.
    .addOption(new Option('--token <token>').hideHelp())
    // Excess arguments are checked by the action: commander's own error would quote them, token included.
    .allowExcessArguments()
    .addHelpText(
      'after',
      `
The token is never accepted as an argument (it would stay in your shell history and in the process list).
Run this command in your own terminal and paste it at the hidden prompt, or pipe it with --token-stdin.
${GUIDANCE}`,
    )
    .action(async (opts, cmd) => {
      if (opts.token !== undefined || cmd.args.length > 0) {
        for (const secret of [opts.token ?? '', ...cmd.args]) registerSecret(ctx, secret);
        throw new CliError(
          'usage',
          'The API token cannot be passed as an argument: it would stay in your shell history and in the process list.',
          {
            hint: `Run \`cf-pages login\` in your own terminal and paste the token at the hidden prompt, or pipe it with --token-stdin. A token typed on a command line is exposed: revoke it and create a new one. Manage tokens: ${API_TOKENS_URL}`,
          },
        );
      }
      await runLogin(ctx, readGlobalFlags(cmd, ctx.env), opts);
    });

  program
    .command('logout')
    .description('Delete the saved token and login (CF_PAGES_* environment variables are not touched)')
    .action(async (_opts, cmd) => {
      await runLogout(ctx, readGlobalFlags(cmd, ctx.env));
    });

  program
    .command('whoami')
    .description('Show which account the CLI uses, where the token comes from, and whether Cloudflare still accepts it')
    .action(async (_opts, cmd) => {
      await runWhoami(ctx, readGlobalFlags(cmd, ctx.env));
    });
}
