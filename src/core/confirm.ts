import { CliError } from './errors.js';
import type { GlobalFlags } from './flags.js';
import type { IO } from './io.js';

export type ConfirmLevel = 'preview' | 'production';

export interface Settings {
  /** When true, production mutations are only accepted from an interactive terminal, even with `--confirm`. */
  productionRequiresTty: boolean;
}

export interface MutationRequest {
  level: ConfirmLevel;
  project: string;
  /** Human description of what is about to happen, e.g. `Redeploy main`. Shown in the preview prompt. */
  action: string;
}

/** Prompts exist only when stdin and stderr are both TTYs and `--no-input` was not passed. Agents must never hang. */
export function canPrompt(io: IO, flags: GlobalFlags): boolean {
  return io.stdinIsTTY && io.stderrIsTTY && flags.input;
}

/**
 * Safety gate for every mutating command. Resolves when the mutation may go ahead; otherwise throws a `CliError`.
 * It never prompts when `canPrompt` is false: it throws `confirmation_required` naming the flag to pass.
 *
 * - preview: a yes/no prompt (default no), or `--yes` or `--confirm <project>` when there is no prompt.
 * - production: the project name typed in a prompt, or `--confirm <project>`. `--yes` is never enough.
 *
 * `--confirm` is the stronger flag, so it satisfies both levels; a value that is not the project is always `usage`.
 */
export async function confirmMutation(
  io: IO,
  flags: GlobalFlags,
  settings: Settings,
  req: MutationRequest,
): Promise<void> {
  const interactive = canPrompt(io, flags);
  if (req.level === 'preview') return confirmPreview(io, flags, interactive, req);
  return confirmProduction(io, flags, settings, interactive, req);
}

/** True when `--confirm` names the project. Throws `usage` when it names anything else; false when it is absent. */
function confirmFlagMatches(flags: GlobalFlags, req: MutationRequest): boolean {
  if (flags.confirm === undefined) return false;
  if (flags.confirm !== req.project) {
    throw new CliError('usage', `--confirm ${flags.confirm} does not match the project (${req.project}).`, {
      hint: `Pass --confirm ${req.project} if this is the project you mean to change.`,
      details: { level: req.level, project: req.project },
    });
  }
  return true;
}

async function confirmPreview(io: IO, flags: GlobalFlags, interactive: boolean, req: MutationRequest): Promise<void> {
  if (confirmFlagMatches(flags, req) || flags.yes) return;
  if (!interactive) {
    throw new CliError('confirmation_required', `${req.action} needs confirmation, and prompts are not available.`, {
      hint: `Re-run with --yes (or --confirm ${req.project}) to confirm, or run the command from an interactive terminal.`,
      details: { level: req.level, project: req.project },
    });
  }
  if (!(await io.prompts.confirm(`${req.action}. Continue?`, { default: false }))) {
    throw new CliError('cancelled', 'Cancelled by the user.', {
      hint: 'Re-run the command and answer yes to continue, or pass --yes to skip the prompt.',
    });
  }
}

async function confirmProduction(
  io: IO,
  flags: GlobalFlags,
  settings: Settings,
  interactive: boolean,
  req: MutationRequest,
): Promise<void> {
  const { project } = req;

  // The setting wins over --confirm: with it on, only a person at a terminal may change production.
  if (settings.productionRequiresTty && !interactive) {
    throw new CliError(
      'confirmation_required',
      'This changes production, and the productionRequiresTty setting only allows that from an interactive terminal.',
      {
        hint: 'Ask the person to run this command themselves in a terminal, or set productionRequiresTty to false.',
        details: { level: req.level, project },
      },
    );
  }

  if (confirmFlagMatches(flags, req)) return;

  if (!interactive) {
    throw new CliError(
      'confirmation_required',
      `This changes production. Re-run with --confirm ${project} (--yes is not enough).`,
      {
        hint: `Pass --confirm ${project} once the person has approved this change, or run the command from an interactive terminal.`,
        details: { level: req.level, project },
      },
    );
  }

  const typed = await io.prompts.text(`Type the project name (${project}) to confirm:`);
  if (typed !== project) {
    throw new CliError('cancelled', 'Cancelled: the name typed does not match the project.', {
      hint: `Re-run the command and type ${project} exactly to confirm.`,
    });
  }
}
