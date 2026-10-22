import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from '@commander-js/extra-typings';
import { afterAll } from 'vitest';
import { readConfig, writeConfig } from '../../src/core/config/store.js';
import type { Context } from '../../src/core/context.js';
import { KEYRING_HINT, PROFILE, type SecretStore } from '../../src/core/credentials/types.js';
import { CliError } from '../../src/core/errors.js';
import type { IO, Prompts } from '../../src/core/io.js';
import { createRedactor } from '../../src/core/redact.js';
import { main } from '../../src/main.js';
import { VERSION } from '../../src/version.js';
import { ACCT, settleRecordedRequests, TEST_TOKEN } from './cf.js';

export type Answer = string | boolean;

export interface FakeIOOptions {
  tty?: boolean;
  stdin?: string;
  answers?: Answer[];
}

/**
 * `prompts` is both the recorded prompt messages (`io.prompts[0]`) and the `Prompts` implementation
 * (`io.prompts.confirm(…)`), which is why the type is the intersection.
 */
export type FakeIO = IO & { out: string; err: string; prompts: string[] };

/** In-memory `IO`: captures output, replays scripted `answers` and records every prompt message. */
export function fakeIO(opts: FakeIOOptions = {}): FakeIO {
  const tty = opts.tty ?? false;
  const queue = [...(opts.answers ?? [])];
  const recorded: string[] = [];
  let out = '';
  let err = '';

  const nextAnswer = (message: string): Answer => {
    recorded.push(message);
    const answer = queue.shift();
    if (answer === undefined) throw new Error(`Unexpected prompt: ${message}`);
    return answer;
  };
  const stringAnswer = (message: string): string => {
    const answer = nextAnswer(message);
    if (typeof answer !== 'string') throw new Error(`Expected a string answer for prompt: ${message}`);
    return answer;
  };

  const methods: Prompts = {
    async text(message, o) {
      const answer = stringAnswer(message);
      if (answer === '' && o?.default !== undefined) return o.default;
      const verdict = o?.validate?.(answer);
      if (verdict !== undefined && verdict !== true)
        throw new Error(`Invalid answer for prompt "${message}": ${verdict}`);
      return answer;
    },
    async password(message) {
      return stringAnswer(message);
    },
    async confirm(message, o) {
      const answer = nextAnswer(message);
      if (typeof answer !== 'boolean') {
        if (answer === '' && o?.default !== undefined) return o.default;
        throw new Error(`Expected a boolean answer for prompt: ${message}`);
      }
      return answer;
    },
    async select<T extends string>(message: string, choices: { value: T; name: string }[]): Promise<T> {
      const answer = stringAnswer(message);
      const choice = choices.find((c) => c.value === answer);
      if (!choice) throw new Error(`Answer "${answer}" is not a choice of prompt: ${message}`);
      return choice.value;
    },
  };
  const prompts = Object.assign(recorded, methods);

  return {
    stdout(t) {
      out += t;
    },
    stderr(t) {
      err += t;
    },
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    stderrIsTTY: tty,
    readStdin: async () => opts.stdin ?? '',
    prompts,
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

export interface RunOptions extends FakeIOOptions {
  /** Environment seen by the CLI. Defaults to `{}`: the real `process.env` never leaks into tests. */
  env?: Record<string, string | undefined>;
  /** Defaults to a fresh temporary directory per call. */
  configDir?: string;
  /** Start of the virtual clock. Defaults to the current time. */
  now?: Date;
  /** Adds extra commands to the program (receives the test `Context`). Mirrors `main`'s `configure` hook. */
  configure?: (program: Command, ctx: Context) => void;
  /**
   * The OS keychain, in memory: account → token. Defaults to an empty one, so the real keychain is never touched.
   * `'unavailable'` makes `ctx.openKeyring()` fail like a machine without a secure store.
   */
  keyring?: Map<string, string> | 'unavailable';
  opened?: string[];
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  prompts: string[];
  opened: string[];
  /** Parses the whole of stdout as one JSON document; throws if stdout holds anything else. */
  // biome-ignore lint/suspicious/noExplicitAny: test helper, callers narrow the shape themselves
  json<T = any>(): T;
}

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cf-pages-test-'));
  tempDirs.push(dir);
  return dir;
}

/** A `SecretStore` backed by a plain map, standing in for the OS keychain. */
export function fakeKeyringStore(entries: Map<string, string>): SecretStore {
  return {
    kind: 'keyring',
    get: async (account) => entries.get(account) ?? null,
    set: async (account, secret) => {
      entries.set(account, secret);
    },
    delete: async (account) => entries.delete(account),
  };
}

/** The `Context` and fake IO that `runCli` uses, for tests that exercise core code without going through commander. */
export async function createTestContext(
  opts: RunOptions = {},
): Promise<{ ctx: Context; io: FakeIO; opened: string[] }> {
  const io = fakeIO(opts);
  const configDir = opts.configDir ?? (await makeTempDir());
  // Virtual clock: `sleep` resolves immediately but advances `now`, so polling loops and timeouts stay deterministic.
  let clock = (opts.now ?? new Date()).getTime();
  const keyring = opts.keyring ?? new Map<string, string>();
  const opened = opts.opened ?? [];
  const ctx: Context = {
    io,
    env: opts.env ?? {},
    platform: process.platform,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    configDir,
    redactor: createRedactor(),
    version: VERSION,
    openKeyring: async () => {
      if (keyring === 'unavailable') {
        throw new CliError('keyring_unavailable', 'No secure credential store is available on this system.', {
          hint: KEYRING_HINT,
        });
      }
      return fakeKeyringStore(keyring);
    },
    openUrl: async (url) => {
      opened.push(url);
    },
  };
  return { ctx, io, opened };
}

/**
 * Options for a machine where `cf-pages login` has already run: a `default` profile ('Acme', `ACCT`, keyring storage,
 * account token) in a temporary config directory, and the token `TEST_TOKEN` in the fake keyring under `default`.
 * Anything in `opts` (env, tty, answers, a keyring map…) is kept.
 */
export async function loggedIn(opts: RunOptions = {}): Promise<RunOptions> {
  const configDir = opts.configDir ?? (await makeTempDir());
  const config = await readConfig(configDir);
  config.profiles.default = {
    label: 'Acme',
    accountId: ACCT,
    storage: 'keyring',
    tokenType: 'account',
    createdAt: '2026-10-21T12:00:00.000Z',
  };
  await writeConfig(configDir, config);
  const keyring = opts.keyring ?? new Map<string, string>();
  if (keyring !== 'unavailable') keyring.set(PROFILE, TEST_TOKEN);
  return { ...opts, configDir, keyring };
}

/** Runs the CLI end to end with a fake IO and returns its exit code and captured output. Never exits the process. */
export async function runCli(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { ctx, io, opened } = await createTestContext(opts);
  const exitCode = await main(args, ctx, (program) => opts.configure?.(program, ctx));
  await settleRecordedRequests();
  return {
    exitCode,
    stdout: io.out,
    stderr: io.err,
    prompts: [...io.prompts],
    opened,
    json: <T>() => JSON.parse(io.out) as T,
  };
}
