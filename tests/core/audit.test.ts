import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUDIT_FILE, type AuditEntry, appendAudit } from '../../src/core/audit.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cf-pages-audit-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const first: AuditEntry = {
  ts: '2026-10-21T12:00:00.000Z',
  command: 'env set',
  project: 'my-site',
  env: 'preview',
  keys: ['API_URL', 'FEATURE_FLAG'],
  result: 'ok',
  credentialSource: 'env',
};
const second: AuditEntry = {
  ts: '2026-10-21T12:05:00.000Z',
  command: 'redeploy',
  project: 'my-site',
  env: 'production',
  deploymentId: 'dep-123',
  result: 'error',
  errorCode: 'api_error',
  credentialSource: 'keyring',
};

describe('appendAudit', () => {
  it('writes one JSON object per line', async () => {
    expect(await appendAudit(dir, first)).toBe(true);
    expect(await appendAudit(dir, second)).toBe(true);
    const text = await readFile(join(dir, AUDIT_FILE), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([first, second]);
  });

  posixOnly('creates the file with 0600 and the missing directory with 0700', async () => {
    const nested = join(dir, 'cf-pages');
    expect(await appendAudit(nested, first)).toBe(true);
    expect((await stat(join(nested, AUDIT_FILE))).mode & 0o777).toBe(0o600);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
  });

  posixOnly('tightens permissions of pre-existing directory and audit.log', async () => {
    const nested = join(dir, 'cf-pages');
    await mkdir(nested, { recursive: true, mode: 0o755 });
    await writeFile(join(nested, AUDIT_FILE), '', { mode: 0o644 });
    expect(await appendAudit(nested, first)).toBe(true);
    expect((await stat(nested)).mode & 0o777).toBe(0o700);
    expect((await stat(join(nested, AUDIT_FILE))).mode & 0o777).toBe(0o600);
  });

  it('uses audit.log', () => {
    expect(AUDIT_FILE).toBe('audit.log');
  });

  it('returns false instead of throwing when the log cannot be written', async () => {
    const notADirectory = join(dir, 'file');
    await writeFile(notADirectory, 'x');
    await expect(appendAudit(notADirectory, first)).resolves.toBe(false);
    await expect(appendAudit(join(notADirectory, 'nested'), first)).resolves.toBe(false);
  });
});
