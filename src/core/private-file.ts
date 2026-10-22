import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Writes `dir/name` atomically and privately: the directory is created/hardened with 0700, the content goes to an
 * unpredictable temporary file created exclusively with 'wx' and 0600, and is then renamed over the target, so a
 * crash never leaves a half-written file.
 */
export async function writePrivateFile(dir: string, name: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(dir, 0o700).catch(() => {});
  }
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
    if (process.platform !== 'win32') {
      await chmod(tmp, 0o600).catch(() => {});
    }
    await rename(tmp, path);
    if (process.platform !== 'win32') {
      await chmod(path, 0o600).catch(() => {});
    }
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
