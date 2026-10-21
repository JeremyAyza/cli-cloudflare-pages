import type { CommandUnknownOpts } from '@commander-js/extra-typings';

export interface GlobalFlags {
  json: boolean;
  yes: boolean;
  confirm?: string;
  dryRun: boolean;
  /** `false` when `--no-input` was passed. */
  input: boolean;
  /** `false` when `--no-color` was passed. */
  color: boolean;
  debug: boolean;
}

/** Reads the global options from a command or any of its ancestors, wherever they appeared on the command line. */
export function readGlobalFlags(cmd: CommandUnknownOpts): GlobalFlags {
  const o: Record<string, unknown> = cmd.optsWithGlobals();
  return {
    json: o.json === true,
    yes: o.yes === true,
    confirm: typeof o.confirm === 'string' ? o.confirm : undefined,
    dryRun: o.dryRun === true,
    input: o.input !== false,
    color: o.color !== false,
    debug: o.debug === true,
  };
}
