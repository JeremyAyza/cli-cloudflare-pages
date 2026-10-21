import { stripVTControlCharacters, styleText } from 'node:util';
import type { CliError } from './errors.js';
import type { GlobalFlags } from './flags.js';
import type { IO } from './io.js';

type Stream = 'stdout' | 'stderr';
type Style = Parameters<typeof styleText>[0];

/**
 * Colors `text` for the given stream, unless `flags.color` is off (`--no-color`, `NO_COLOR` and `TERM=dumb` are
 * already folded into it by `readGlobalFlags`) or that stream is not a TTY.
 */
export function paint(io: IO, flags: GlobalFlags, stream: Stream, format: Style, text: string): string {
  const isTTY = stream === 'stdout' ? io.stdoutIsTTY : io.stderrIsTTY;
  if (!flags.color || !isTTY) return text;
  // The decision is already made from `io`, so styleText must not second-guess it against the real process streams.
  return styleText(format, text, { validateStream: false });
}

/** Aligned plain-text table: two spaces between columns, no trailing whitespace. */
export function renderTable(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows];
  const widths = headers.map((_, col) =>
    Math.max(...lines.map((line) => stripVTControlCharacters(line[col] ?? '').length)),
  );
  return lines
    .map((line) =>
      widths
        .map((width, col) => {
          const cell = line[col] ?? '';
          return cell + ' '.repeat(width - stripVTControlCharacters(cell).length);
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export interface Output {
  /** The command's single result. In `--json` mode it is the whole stdout document; calling it twice throws. */
  data<T>(value: T, human: (v: T) => string): void;
  /** Progress or informational line, always on stderr. */
  note(msg: string): void;
  /** Non-fatal problem, always on stderr. */
  warn(msg: string): void;
  /** Names the account in use: a stderr line in human mode, the `account` field in `--json` mode. */
  header(a: { label: string; accountId: string }): void;
}

export function createOutput(io: IO, flags: GlobalFlags): Output {
  let account: { label: string; accountId: string } | undefined;
  let emitted = false;

  return {
    data(value, human) {
      if (emitted) throw new Error('Output.data() was called more than once; a command emits a single result.');
      emitted = true;
      if (flags.json) {
        io.stdout(`${JSON.stringify({ ok: true, ...(account ? { account } : {}), data: value })}\n`);
      } else {
        io.stdout(`${human(value)}\n`);
      }
    },
    note(msg) {
      io.stderr(`${msg}\n`);
    },
    warn(msg) {
      io.stderr(`${paint(io, flags, 'stderr', 'yellow', `Warning: ${msg}`)}\n`);
    },
    header({ label, accountId }) {
      if (flags.json) {
        account = { label, accountId };
      } else {
        io.stderr(`${paint(io, flags, 'stderr', 'dim', `${label} · account …${accountId.slice(-7)}`)}\n`);
      }
    },
  };
}

/** Reports an error: one JSON document on stdout with `--json`, otherwise message and hint on stderr. */
export function renderError(io: IO, flags: GlobalFlags, err: CliError): void {
  if (flags.json) {
    const error = {
      code: err.code,
      message: err.message,
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
      ...(err.details !== undefined ? { details: err.details } : {}),
    };
    io.stdout(`${JSON.stringify({ ok: false, error })}\n`);
    return;
  }
  io.stderr(`${paint(io, flags, 'stderr', ['red', 'bold'], 'Error:')} ${err.message}\n`);
  if (err.hint !== undefined) io.stderr(`${paint(io, flags, 'stderr', 'dim', 'Hint:')} ${err.hint}\n`);
}
