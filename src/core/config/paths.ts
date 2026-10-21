import { posix, win32 } from 'node:path';

/**
 * Directory for cf-pages configuration.
 * `CF_PAGES_CONFIG_DIR` overrides everything; otherwise `%APPDATA%\cf-pages` on Windows and
 * `$XDG_CONFIG_HOME/cf-pages` (default `~/.config/cf-pages`) elsewhere.
 */
export function defaultConfigDir(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  homedir: string,
): string {
  if (env.CF_PAGES_CONFIG_DIR) return env.CF_PAGES_CONFIG_DIR;
  if (platform === 'win32') {
    return win32.join(env.APPDATA || win32.join(homedir, 'AppData', 'Roaming'), 'cf-pages');
  }
  return posix.join(env.XDG_CONFIG_HOME || posix.join(homedir, '.config'), 'cf-pages');
}
