import type { CommandUnknownOpts } from '@commander-js/extra-typings';

export interface GlobalFlags {
  json: boolean;
  yes: boolean;
  confirm?: string;
  dryRun: boolean;
  /** `false` when `--no-input` was passed. */
  input: boolean;
  /** `false` when `--no-color` was passed, `NO_COLOR` is non-empty or `TERM=dumb` (see `readGlobalFlags`). */
  color: boolean;
  debug: boolean;
}

/**
 * Reads the global options from a command or any of its ancestors, wherever they appeared on the command line.
 * `color` also folds in the injected environment, so nothing downstream needs to read `process.env`.
 */
export function readGlobalFlags(
  cmd: CommandUnknownOpts,
  env: Readonly<Record<string, string | undefined>>,
): GlobalFlags {
  const o: Record<string, unknown> = cmd.optsWithGlobals();
  return {
    json: o.json === true,
    yes: o.yes === true,
    confirm: typeof o.confirm === 'string' ? o.confirm : undefined,
    dryRun: o.dryRun === true,
    input: o.input !== false,
    color: o.color !== false && !env.NO_COLOR && env.TERM !== 'dumb',
    debug: o.debug === true,
  };
}
