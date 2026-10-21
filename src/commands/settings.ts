import type { Command } from '@commander-js/extra-typings';
import { readConfig, writeConfig } from '../core/config/store.js';
import { canPrompt } from '../core/confirm.js';
import type { Context } from '../core/context.js';
import { CliError } from '../core/errors.js';
import { readGlobalFlags } from '../core/flags.js';
import { createOutput } from '../core/output.js';

/** Every setting is a boolean; `productionRequiresTty` is the only one in v1. */
const SETTING_KEYS = ['productionRequiresTty'] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

function parseKey(raw: string): SettingKey {
  const key = SETTING_KEYS.find((candidate) => candidate === raw);
  if (key === undefined) {
    throw new CliError('usage', `Unknown setting "${raw}".`, {
      hint: `Available settings: ${SETTING_KEYS.join(', ')}. Run "cf-pages settings get" to see their values.`,
    });
  }
  return key;
}

function parseValue(key: SettingKey, raw: string): boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new CliError('usage', `Invalid value "${raw}" for ${key}.`, {
    hint: `${key} accepts true or false, for example: cf-pages settings set ${key} true`,
  });
}

/** Registers `settings get [key]` and `settings set <key> <value>`. */
export function registerSettings(program: Command, ctx: Context): void {
  const settings = program.command('settings').description('Show or change cf-pages settings');

  settings
    .command('get')
    .description('Show one setting, or all of them')
    .argument('[key]', `setting name (${SETTING_KEYS.join(', ')})`)
    .action(async (rawKey, _opts, cmd) => {
      const flags = readGlobalFlags(cmd, ctx.env);
      const out = createOutput(ctx.io, flags);
      const keys = rawKey === undefined ? SETTING_KEYS : [parseKey(rawKey)];
      const config = await readConfig(ctx.configDir);
      const data = Object.fromEntries(keys.map((key) => [key, config.settings[key]]));
      out.data(data, (view) =>
        Object.entries(view)
          .map(([key, value]) => `${key}: ${value}`)
          .join('\n'),
      );
    });

  settings
    .command('set')
    .description('Change a setting (interactive terminal only)')
    .argument('<key>', `setting name (${SETTING_KEYS.join(', ')})`)
    .argument('<value>', 'true or false')
    .addHelpText(
      'after',
      '\nSettings can only be changed by a person at an interactive terminal: --yes and --confirm do not apply,\nso an agent cannot switch off protections such as productionRequiresTty.',
    )
    .action(async (rawKey, rawValue, _opts, cmd) => {
      const flags = readGlobalFlags(cmd, ctx.env);
      const key = parseKey(rawKey);
      const value = parseValue(key, rawValue);

      // The gate that keeps an agent from disabling productionRequiresTty: no flag can unlock it.
      if (!canPrompt(ctx.io, flags)) {
        throw new CliError('confirmation_required', 'Settings can only be changed from an interactive terminal.', {
          hint: `Ask the person to run "cf-pages settings set ${key} ${value}" themselves in a terminal. --yes and --confirm do not apply to settings.`,
          details: { key },
        });
      }

      const out = createOutput(ctx.io, flags);
      const current = await readConfig(ctx.configDir);

      if (flags.dryRun) {
        const from = current.settings[key];
        out.data(
          { dryRun: true, key, from, to: value },
          () => `Would set ${key} from ${from} to ${value}. Nothing changed.`,
        );
        return;
      }

      if (!(await ctx.io.prompts.confirm(`Set ${key} to ${value}?`, { default: false }))) {
        throw new CliError('cancelled', 'Cancelled by the user.', {
          hint: `Re-run the command and answer yes to change ${key}.`,
        });
      }

      // Read again: the prompt can stay open for a while and other commands (login) write to the same file.
      const latest = await readConfig(ctx.configDir);
      await writeConfig(ctx.configDir, { ...latest, settings: { ...latest.settings, [key]: value } });
      out.data({ [key]: value }, () => `${key} set to ${value}.`);
    });
}
