import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from '@commander-js/extra-typings';
import { afterAll } from 'vitest';
import type { Context } from '../../src/core/context.js';
import type { IO, Prompts } from '../../src/core/io.js';
import { createRedactor } from '../../src/core/redact.js';
import { main } from '../../src/main.js';
import { VERSION } from '../../src/version.js';
import { settleRecordedRequests } from './cf.js';

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
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  prompts: string[];
  /** Parses the whole of stdout as one JSON document; throws if stdout holds anything else. */
  // biome-ignore lint/suspicious/noExplicitAny: test helper, callers narrow the shape themselves
  json<T = any>(): T;
}

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Runs the CLI end to end with a fake IO and returns its exit code and captured output. Never exits the process. */
export async function runCli(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const io = fakeIO(opts);
  let configDir = opts.configDir;
  if (configDir === undefined) {
    configDir = await mkdtemp(join(tmpdir(), 'cf-pages-test-'));
    tempDirs.push(configDir);
  }
  // Virtual clock: `sleep` resolves immediately but advances `now`, so polling loops and timeouts stay deterministic.
  let clock = (opts.now ?? new Date()).getTime();
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
  };
  const exitCode = await main(args, ctx, (program) => opts.configure?.(program, ctx));
  await settleRecordedRequests();
  return {
    exitCode,
    stdout: io.out,
    stderr: io.err,
    prompts: [...io.prompts],
    json: <T>() => JSON.parse(io.out) as T,
  };
}
