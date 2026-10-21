import { confirm, input, password, select } from '@inquirer/prompts';
import { CliError } from './errors.js';

export interface Prompts {
  text(msg: string, o?: { default?: string; validate?: (v: string) => true | string }): Promise<string>;
  password(msg: string): Promise<string>;
  confirm(msg: string, o?: { default?: boolean }): Promise<boolean>;
  select<T extends string>(msg: string, choices: { value: T; name: string }[]): Promise<T>;
}

export interface IO {
  stdout(t: string): void;
  stderr(t: string): void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  readStdin(): Promise<string>;
  prompts: Prompts;
}

/** Inquirer rejects with `ExitPromptError` on Ctrl+C; matched by name so no transitive package is imported. */
async function cancellable<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Error && err.name === 'ExitPromptError') {
      throw new CliError('cancelled', 'Cancelled by the user.', { cause: err });
    }
    throw err;
  }
}

/** Prompts are drawn on stderr so stdout stays clean for data. */
function createNodePrompts(): Prompts {
  const context = { output: process.stderr };
  return {
    text: (message, o) =>
      cancellable(() =>
        input(
          {
            message,
            ...(o?.default !== undefined ? { default: o.default } : {}),
            ...(o?.validate ? { validate: o.validate } : {}),
          },
          context,
        ),
      ),
    password: (message) => cancellable(() => password({ message, mask: '*' }, context)),
    confirm: (message, o) =>
      cancellable(() => confirm({ message, ...(o?.default !== undefined ? { default: o.default } : {}) }, context)),
    select: (message, choices) => cancellable(() => select({ message, choices }, context)),
  };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function createNodeIO(): IO {
  return {
    stdout: (t) => {
      process.stdout.write(t);
    },
    stderr: (t) => {
      process.stderr.write(t);
    },
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    readStdin: () => readAll(process.stdin),
    prompts: createNodePrompts(),
  };
}
