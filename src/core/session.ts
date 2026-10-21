import { type AuditEntry, appendAuditOrWarn } from './audit.js';
import { readConfig } from './config/store.js';
import { type ConfirmLevel, confirmMutation, type Settings } from './confirm.js';
import type { Context } from './context.js';
import { resolveCredentials } from './credentials/resolve.js';
import type { Credentials } from './credentials/types.js';
import type { GlobalFlags } from './flags.js';
import { ApiClient } from './http/client.js';
import { createOutput, type Output } from './output.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 7;

/** Everything a command needs for one run: output, settings, credentials, the confirmation gate and the audit log. */
export interface Session {
  ctx: Context;
  flags: GlobalFlags;
  out: Output;
  settings(): Promise<Settings>;
  /** Resolved once per session. The first call also registers the token for redaction and shows the account header. */
  credentials(): Promise<Credentials>;
  /** The Cloudflare API client, built once per session from `credentials()`. With `--debug` it logs request lines to stderr. */
  client(): Promise<ApiClient>;
  confirm(req: { level: ConfirmLevel; project: string; action: string }): Promise<void>;
  /** Appends to the audit log. Never throws: a log that cannot be written only produces a warning. */
  audit(e: Omit<AuditEntry, 'ts' | 'credentialSource'>): Promise<void>;
}

function warnIfExpiring(out: Output, ctx: Context, expiresOn: string | undefined): void {
  if (expiresOn === undefined) return;
  const expires = Date.parse(expiresOn);
  if (Number.isNaN(expires)) return;
  const remaining = expires - ctx.now().getTime();
  if (remaining > EXPIRY_WARNING_DAYS * DAY_MS) return;
  const date = new Date(expires).toISOString().slice(0, 10);
  out.warn(remaining < 0 ? `API token expired on ${date}.` : `API token expires on ${date}.`);
}

export function createSession(ctx: Context, flags: GlobalFlags): Session {
  const out = createOutput(ctx.io, flags);
  let settings: Promise<Settings> | undefined;
  let credentials: Promise<Credentials> | undefined;
  let client: Promise<ApiClient> | undefined;

  async function loadCredentials(): Promise<Credentials> {
    const resolved = await resolveCredentials(ctx);
    ctx.redactor.add(resolved.token);
    out.header({ label: resolved.label, accountId: resolved.accountId });
    warnIfExpiring(out, ctx, resolved.tokenExpiresOn);
    return resolved;
  }

  async function createClient(): Promise<ApiClient> {
    const { token } = await session.credentials();
    return new ApiClient({
      token,
      userAgent: `cf-pages/${ctx.version}`,
      sleep: (ms) => ctx.sleep(ms),
      ...(flags.debug ? { debug: (line: string) => ctx.io.stderr(`${ctx.redactor.apply(line)}\n`) } : {}),
    });
  }

  const session: Session = {
    ctx,
    flags,
    out,
    settings() {
      settings ??= readConfig(ctx.configDir).then((config) => config.settings);
      return settings;
    },
    credentials() {
      credentials ??= loadCredentials();
      return credentials;
    },
    client() {
      client ??= createClient();
      return client;
    },
    async confirm(req) {
      await confirmMutation(ctx.io, flags, await session.settings(), req);
    },
    async audit(e) {
      // Commands that failed before they had credentials have no source to record.
      const source = await session.credentials().then(
        (c) => c.source,
        () => undefined,
      );
      const entry: AuditEntry = {
        ts: ctx.now().toISOString(),
        ...e,
        ...(source === undefined ? {} : { credentialSource: source }),
      };
      await appendAuditOrWarn(out, ctx.configDir, entry);
    },
  };
  return session;
}
