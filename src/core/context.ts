import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION } from '../version.js';
import { defaultConfigDir } from './config/paths.js';
import { createNodeIO, type IO } from './io.js';
import { createRedactor, type Redactor } from './redact.js';

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
}

export function createNodeContext(): Context {
  return {
    io: createNodeIO(),
    env: process.env,
    platform: process.platform,
    now: () => new Date(),
    sleep: (ms) => delay(ms),
    configDir: defaultConfigDir(process.env, process.platform, homedir()),
    redactor: createRedactor(),
    version: VERSION,
  };
}
