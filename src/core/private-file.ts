import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Writes `dir/name` atomically and privately: the directory is created with 0700, the content goes to a temporary
 * file created with 0600 and is then renamed over the target, so a crash never leaves a half-written file.
 */
export async function writePrivateFile(dir: string, name: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}
