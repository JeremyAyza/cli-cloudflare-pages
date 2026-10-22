import { appendFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Output } from './output.js';

export const AUDIT_FILE = 'audit.log';

/** One line of the local audit log. Holds key names, never values. */
export interface AuditEntry {
  ts: string;
  command: string;
  project?: string;
  env?: 'production' | 'preview';
  deploymentId?: string;
  keys?: string[];
  result: 'ok' | 'error';
  errorCode?: string;
  /** Absent for commands that use no credentials, such as `settings set`. */
  credentialSource?: 'env' | 'keyring' | 'file';
}

/**
 * Appends one JSON object as a line of `audit.log` (file 0600, directory 0700 when it has to be created or tightened).
 * The audit log must never break the command it records, so this never throws: it returns false on failure.
 */
export async function appendAudit(dir: string, entry: AuditEntry): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      await chmod(dir, 0o700).catch(() => {});
    }
    const file = join(dir, AUDIT_FILE);
    await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(file, 0o600).catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

/** `appendAudit`, but a failure is reported as a warning so the person knows the log is incomplete. */
export async function appendAuditOrWarn(out: Pick<Output, 'warn'>, dir: string, entry: AuditEntry): Promise<void> {
  if (!(await appendAudit(dir, entry))) {
    out.warn(`Could not write to the audit log (${join(dir, AUDIT_FILE)}).`);
  }
}
