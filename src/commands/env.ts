import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import type { Command } from '@commander-js/extra-typings';
import type { Context } from '../core/context.js';
import { CliError } from '../core/errors.js';
import { readGlobalFlags } from '../core/flags.js';
import { renderTable } from '../core/output.js';
import { createSession } from '../core/session.js';
import { sectionDashboardUrl } from '../providers/pages/dashboard.js';
import { isWranglerManaged } from '../providers/pages/diagnose.js';
import {
  buildEnvPatch,
  currentEnvVars,
  type EnvVarType,
  envVarView,
  hasChanges,
  planItemView,
  planSet,
  planUnset,
  renderPlan,
  verifyApplied,
} from '../providers/pages/env.js';
import type { PagesEnv } from '../providers/pages/types.js';
import { deploymentView } from '../providers/pages/views.js';
import { pagesApi } from './shared.js';

export function registerEnv(program: Command, ctx: Context): void {
  const envCmd = program.command('env').description('Manage Cloudflare Pages environment variables.');

  envCmd
    .command('list <project>')
    .description('List environment variables for a project.')
    .option('--env <env>', 'filter by environment (production | preview)')
    .action(async (project, opts, cmd) => {
      if (opts.env && opts.env !== 'production' && opts.env !== 'preview') {
        throw new CliError('usage', "Invalid environment: must be 'production' or 'preview'.");
      }

      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api, accountId } = await pagesApi(session);

      const p = await api.getProject(project);

      const targetEnvs: PagesEnv[] = opts.env ? [opts.env as PagesEnv] : ['production', 'preview'];

      const environments: { production?: ReturnType<typeof envVarView>[]; preview?: ReturnType<typeof envVarView>[] } =
        {};

      for (const e of targetEnvs) {
        const vars = currentEnvVars(p, e);
        environments[e] = Object.entries(vars).map(([k, v]) => envVarView(k, v));
      }

      const dashboardUrl = sectionDashboardUrl(accountId, project, 'variables');

      session.out.data(
        {
          project,
          environments,
          dashboardUrl,
        },
        (data) => {
          const lines: string[] = [`Environment variables for ${project}:`, `Dashboard: ${data.dashboardUrl}\n`];
          for (const [envName, envList] of Object.entries(data.environments)) {
            lines.push(`[${envName.toUpperCase()}]`);
            if (!envList || envList.length === 0) {
              lines.push('  No variables defined.\n');
              continue;
            }
            const headers = ['KEY', 'TYPE', 'VALUE', 'LENGTH'];
            const rows = envList.map((v) => [
              v.key,
              v.type,
              v.masked ?? '[secret — not readable]',
              v.length !== null ? String(v.length) : '-',
            ]);
            lines.push(renderTable(headers, rows));
            lines.push('');
          }
          return lines.join('\n');
        },
      );
    });

  envCmd
    .command('get <project> <key>')
    .description('Get an environment variable value.')
    .requiredOption('--env <env>', 'environment (production | preview)')
    .option('--reveal', 'reveal the full plain text value')
    .action(async (project, key, opts, cmd) => {
      if (opts.env !== 'production' && opts.env !== 'preview') {
        throw new CliError('usage', "Invalid environment: must be 'production' or 'preview'.");
      }

      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api } = await pagesApi(session);

      const p = await api.getProject(project);
      const vars = currentEnvVars(p, opts.env as PagesEnv);
      const v = vars[key];

      if (!v) {
        throw new CliError('not_found', `Variable '${key}' not found in ${opts.env}.`);
      }

      if (opts.reveal) {
        if (v.type === 'secret_text') {
          throw new CliError('usage', 'Cloudflare does not return secret values; secrets can only be overwritten.');
        }

        await session.audit({
          command: 'env get --reveal',
          project,
          env: opts.env as PagesEnv,
          keys: [key],
          result: 'ok',
        });

        session.out.warn(`Revealing plain text value of '${key}' in ${opts.env}.`);
        ctx.io.stdout(`${v.value ?? ''}\n`);
        return;
      }

      const view = envVarView(key, v, false);
      session.out.data(view, (val) => `${val.key}: ${val.masked ?? '[secret — not readable]'}`);
    });

  envCmd
    .command('set <project> [key]')
    .description('Set one or more environment variables.')
    .requiredOption('--env <env>', 'environment (production | preview)')
    .option('--secret', 'store as secret_text')
    .option('--plain', 'store as plain_text')
    .option('--from-file <path>', 'import variables from a dotenv file')
    .option('--redeploy', 'redeploy after changing variables')
    .option('--branch <branch>', 'branch to redeploy for preview environment')
    .action(async (project, key, opts, cmd) => {
      if (opts.env !== 'production' && opts.env !== 'preview') {
        throw new CliError('usage', "Invalid environment: must be 'production' or 'preview'.");
      }
      if (opts.secret && opts.plain) {
        throw new CliError('usage', 'Cannot pass both --secret and --plain.');
      }
      if (key && opts.fromFile) {
        throw new CliError('usage', 'Cannot pass both a key and --from-file.');
      }
      if (!key && !opts.fromFile) {
        throw new CliError('usage', 'A variable key or --from-file is required.');
      }
      if (key?.includes('=')) {
        throw new CliError(
          'usage',
          'Values are never accepted as arguments. Pass the key alone, and provide the value via prompt or stdin.',
        );
      }
      if (opts.redeploy && opts.env === 'preview' && !opts.branch) {
        throw new CliError('usage', '--redeploy in preview requires --branch.');
      }

      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api, accountId } = await pagesApi(session);

      const p = await api.getProject(project);
      const env = opts.env as PagesEnv;
      const before = currentEnvVars(p, env);

      let entries: { key: string; value: string }[] = [];

      if (opts.fromFile) {
        const content = await readFile(opts.fromFile, 'utf8');
        const parsed = parseEnv(content);
        entries = Object.entries(parsed)
          .filter((entry): entry is [string, string] => entry[1] !== undefined)
          .map(([k, val]) => {
            ctx.redactor.add(val);
            return { key: k, value: val };
          });
        if (entries.length === 0) {
          throw new CliError('usage', 'No environment variables found in file.');
        }
      } else if (key) {
        let val = '';
        if (ctx.io.stdinIsTTY && ctx.io.stdoutIsTTY && flags.input) {
          val = await ctx.io.prompts.password(`Value for ${key} (${env}):`);
        } else {
          val = await ctx.io.readStdin();
          val = val.replace(/\r?\n$/, '');
        }

        if (val.length === 0) {
          throw new CliError('usage', 'Empty values are not allowed.');
        }
        ctx.redactor.add(val);
        entries = [{ key, value: val }];
      }

      const explicitType: EnvVarType | undefined = opts.secret ? 'secret_text' : opts.plain ? 'plain_text' : undefined;

      const plan = planSet(before, entries, { env, type: explicitType });

      if (!hasChanges(plan)) {
        session.out.note('No changes.');
        return;
      }

      session.out.note(renderPlan(plan, project));

      const wranglerManaged = isWranglerManaged(p);
      if (wranglerManaged) {
        session.out.warn(
          'Warning: This project is managed by a wrangler configuration file. Changes made here may be overwritten on the next deployment.',
        );
      }

      if (flags.dryRun) {
        session.out.data(
          {
            project,
            env,
            changes: plan.items.map(planItemView),
            applied: false,
            dryRun: true,
          },
          () => '[dry-run] Dry run completed. No changes applied.',
        );
        return;
      }

      const confirmLevel = env === 'production' || wranglerManaged ? 'production' : 'preview';
      await session.confirm({
        level: confirmLevel,
        project,
        action: `update environment variables in ${env}`,
      });

      const patch = buildEnvPatch(plan);
      const hash = p.deployment_configs[env]?.wrangler_config_hash;
      await api.patchEnvVars(project, env, patch, { wranglerConfigHash: hash });

      const updatedP = await api.getProject(project);
      const after = currentEnvVars(updatedP, env);
      const mismatches = verifyApplied(before, plan, after);
      if (mismatches.length > 0) {
        throw new CliError(
          'verification_failed',
          `Cloudflare reports a different result than expected for: ${mismatches.join(', ')}.`,
        );
      }

      await session.audit({
        command: 'env set',
        project,
        env,
        keys: plan.items.map((i) => i.key),
        result: 'ok',
      });

      session.out.note('Changes apply to the next deployment.');

      let redeployView: ReturnType<typeof deploymentView> | undefined;
      if (opts.redeploy) {
        const branch = opts.branch ?? p.production_branch;
        const d = await api.createDeployment(project, branch);
        redeployView = deploymentView(d, accountId);
        session.out.note(`Triggered deployment ${redeployView.shortId} on branch '${branch}'.`);
      }

      session.out.data(
        {
          project,
          env,
          changes: plan.items.map(planItemView),
          applied: true,
          ...(redeployView ? { redeploy: redeployView } : {}),
        },
        () => `Successfully updated ${plan.items.length} variable(s) in ${env}.`,
      );
    });

  envCmd
    .command('unset <project> <keys...>')
    .description('Delete one or more environment variables.')
    .requiredOption('--env <env>', 'environment (production | preview)')
    .option('--redeploy', 'redeploy after changing variables')
    .option('--branch <branch>', 'branch to redeploy for preview environment')
    .action(async (project, keys, opts, cmd) => {
      if (opts.env !== 'production' && opts.env !== 'preview') {
        throw new CliError('usage', "Invalid environment: must be 'production' or 'preview'.");
      }
      if (opts.redeploy && opts.env === 'preview' && !opts.branch) {
        throw new CliError('usage', '--redeploy in preview requires --branch.');
      }

      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api, accountId } = await pagesApi(session);

      const p = await api.getProject(project);
      const env = opts.env as PagesEnv;
      const before = currentEnvVars(p, env);

      const plan = planUnset(before, keys, env);

      session.out.note(renderPlan(plan, project));

      const wranglerManaged = isWranglerManaged(p);
      if (wranglerManaged) {
        session.out.warn(
          'Warning: This project is managed by a wrangler configuration file. Changes made here may be overwritten on the next deployment.',
        );
      }

      if (flags.dryRun) {
        session.out.data(
          {
            project,
            env,
            changes: plan.items.map(planItemView),
            applied: false,
            dryRun: true,
          },
          () => '[dry-run] Dry run completed. No changes applied.',
        );
        return;
      }

      const confirmLevel = env === 'production' || wranglerManaged ? 'production' : 'preview';
      await session.confirm({
        level: confirmLevel,
        project,
        action: `delete environment variable(s) from ${env}`,
      });

      const patch = buildEnvPatch(plan);
      const hash = p.deployment_configs[env]?.wrangler_config_hash;
      await api.patchEnvVars(project, env, patch, { wranglerConfigHash: hash });

      const updatedP = await api.getProject(project);
      const after = currentEnvVars(updatedP, env);
      const mismatches = verifyApplied(before, plan, after);
      if (mismatches.length > 0) {
        throw new CliError(
          'verification_failed',
          `Cloudflare reports a different result than expected for: ${mismatches.join(', ')}.`,
        );
      }

      await session.audit({
        command: 'env unset',
        project,
        env,
        keys,
        result: 'ok',
      });

      session.out.note('Changes apply to the next deployment.');

      let redeployView: ReturnType<typeof deploymentView> | undefined;
      if (opts.redeploy) {
        const branch = opts.branch ?? p.production_branch;
        const d = await api.createDeployment(project, branch);
        redeployView = deploymentView(d, accountId);
        session.out.note(`Triggered deployment ${redeployView.shortId} on branch '${branch}'.`);
      }

      session.out.data(
        {
          project,
          env,
          changes: plan.items.map(planItemView),
          applied: true,
          ...(redeployView ? { redeploy: redeployView } : {}),
        },
        () => `Successfully deleted ${keys.length} variable(s) from ${env}.`,
      );
    });
}
