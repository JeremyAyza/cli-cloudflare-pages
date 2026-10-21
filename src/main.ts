import { Command, CommanderError } from '@commander-js/extra-typings';
import { registerSettings } from './commands/settings.js';
import type { Context } from './core/context.js';
import { CliError } from './core/errors.js';
import { type GlobalFlags, readGlobalFlags } from './core/flags.js';
import { renderError } from './core/output.js';

// The disclaimer sits on its own line so help wrapping can never split the exact sentence.
const DESCRIPTION =
  'Manage Cloudflare Pages projects from the terminal.\nUnofficial. Not affiliated with or endorsed by Cloudflare.';

const EXIT_CODES_HELP = `
Exit codes:
  0  success
  1  unexpected error
  2  invalid usage
  3  authentication required or invalid
  4  not found (project, deployment, variable)
  5  confirmation required or cancelled
  6  Cloudflare API error (including rate limiting)
  7  deployment finished in failure (--wait)
`;

/**
 * Builds the root program. Commander settings are applied before any subcommand is created, so commands
 * registered afterwards inherit them (`exitOverride`, `configureOutput`). Each command module exports a
 * `register…(program, ctx)` function that is called here; later tasks add theirs below `registerSettings`.
 */
export function createProgram(ctx: Context): Command {
  const { io } = ctx;
  const program = new Command()
    .name('cf-pages')
    .description(DESCRIPTION)
    .version(ctx.version)
    .option('--json', 'print a single JSON document on stdout')
    .option('-y, --yes', 'confirm preview-level changes without prompting (never enough for production)')
    .option('--confirm <project>', 'confirm any change by project name (required for production when not prompting)')
    .option('--dry-run', 'show what would happen without changing anything')
    .option('--no-input', 'never prompt; fail when input would be needed')
    .option('--no-color', 'disable colored output')
    .option('--debug', 'print redacted diagnostics to stderr')
    .addHelpText('after', EXIT_CODES_HELP)
    .exitOverride()
    // Commander's own error line is dropped: every error is rendered once, by `renderError`.
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr, outputError: () => {} });

  registerSettings(program, ctx);
  return program;
}

const USAGE_HINT = 'Run "cf-pages --help" to see the available commands and options.';

function usageError(err: CommanderError): CliError {
  // 'commander.help' means a command group was invoked without a subcommand (commander already printed its help).
  const message = err.code === 'commander.help' ? 'A command is required.' : err.message.replace(/^error:\s*/i, '');
  return new CliError('usage', message, { hint: USAGE_HINT, cause: err });
}

/** Parse failures happen before commander finishes reading options, so flags come straight from argv. */
function flagsFromArgv(argv: string[], env: Context['env']): GlobalFlags {
  return {
    json: argv.includes('--json'),
    yes: false,
    dryRun: false,
    input: !argv.includes('--no-input'),
    color: !argv.includes('--no-color') && !env.NO_COLOR && env.TERM !== 'dumb',
    debug: argv.includes('--debug'),
  };
}

function redactDeep(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, redact));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)]));
  }
  return value;
}

/**
 * Every error that reaches the user passes through here once: commander echoes offending argv (which may be a
 * token) and any command may build a message from user input, so message, hint and string details are redacted.
 */
function redactError(err: CliError, ctx: Context): CliError {
  const redact = (text: string) => ctx.redactor.apply(text);
  return new CliError(err.code, redact(err.message), {
    cause: err.cause,
    ...(err.hint !== undefined ? { hint: redact(err.hint) } : {}),
    ...(err.details !== undefined ? { details: redactDeep(err.details, redact) as Record<string, unknown> } : {}),
  });
}

/**
 * Runs the CLI and returns the process exit code; never calls `process.exit`.
 * `configure` lets tests add extra commands to the program.
 */
export async function main(argv: string[], ctx: Context, configure?: (program: Command) => void): Promise<number> {
  const program = createProgram(ctx);
  configure?.(program);

  try {
    if (argv.length === 0) {
      program.outputHelp();
      return 0;
    }
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError && (err.code === 'commander.helpDisplayed' || err.code === 'commander.version')) {
      return 0;
    }
    const parseFailure = err instanceof CommanderError;
    const flags = parseFailure ? flagsFromArgv(argv, ctx.env) : readGlobalFlags(program, ctx.env);
    let cliError: CliError;
    if (err instanceof CliError) {
      cliError = err;
    } else if (err instanceof CommanderError) {
      cliError = usageError(err);
    } else {
      cliError = new CliError('unexpected', err instanceof Error ? err.message : String(err), { cause: err });
    }
    if (flags.debug && !parseFailure && err instanceof Error && err.stack) {
      ctx.io.stderr(`${ctx.redactor.apply(err.stack)}\n`);
    }
    renderError(ctx.io, flags, redactError(cliError, ctx));
    return cliError.exitCode;
  }
}
