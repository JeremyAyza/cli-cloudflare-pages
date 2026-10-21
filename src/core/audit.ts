import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
  credentialSource: 'env' | 'keyring' | 'file';
}

/**
 * Appends one JSON object as a line of `audit.log` (file 0600, directory 0700 when it has to be created).
 * The audit log must never break the command it records, so this never throws: it returns false on failure.
 */
export async function appendAudit(dir: string, entry: AuditEntry): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await appendFile(join(dir, AUDIT_FILE), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
