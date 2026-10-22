import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION } from '../version.js';
import { defaultConfigDir } from './config/paths.js';
import { openKeyringStore } from './credentials/keyring-store.js';
import type { SecretStore } from './credentials/types.js';
import { createNodeIO, type IO } from './io.js';
import { createRedactor, type Redactor } from './redact.js';

function defaultOpenUrl(platform: NodeJS.Platform, url: string): Promise<void> {
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return Promise.resolve();
}

/** Everything a command needs from the outside world, injectable so tests can run the CLI end to end. */
export interface Context {
  io: IO;
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  now(): Date;
  sleep(ms: number): Promise<void>;
  configDir: string;
  redactor: Redactor;
  version: string;
  /** Opens the OS keychain, or rejects with `keyring_unavailable`. Tests inject an in-memory one. */
  openKeyring(): Promise<SecretStore>;
  openUrl(url: string): Promise<void>;
}

export function createNodeContext(): Context {
  const platform = process.platform;
  return {
    io: createNodeIO(),
    env: process.env,
    platform,
    now: () => new Date(),
    sleep: (ms) => delay(ms),
    configDir: defaultConfigDir(process.env, platform, homedir()),
    redactor: createRedactor(),
    version: VERSION,
    openKeyring: openKeyringStore,
    openUrl: (url) => defaultOpenUrl(platform, url),
  };
}
