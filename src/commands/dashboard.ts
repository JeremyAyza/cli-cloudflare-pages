import type { Command } from '@commander-js/extra-typings';
import type { Context } from '../core/context.js';
import { CliError } from '../core/errors.js';
import { readGlobalFlags } from '../core/flags.js';
import { createSession } from '../core/session.js';
import {
  type DashboardSection,
  deploymentDashboardUrl,
  projectDashboardUrl,
  sectionDashboardUrl,
} from '../providers/pages/dashboard.js';
import { resolveDeploymentRef } from '../providers/pages/deployments.js';
import { pagesApi } from './shared.js';

const VALID_SECTIONS = ['deployments', 'settings', 'domains', 'variables', 'builds'] as const;

export function registerDashboard(program: Command, ctx: Context): void {
  program
    .command('dashboard <project> [deployment]')
    .description('Print or open Cloudflare Pages dashboard URLs.')
    .option('--section <section>', 'open a specific section (deployments, settings, domains, variables, builds)')
    .option('--open', 'open the dashboard URL in the default browser (interactive terminal only)')
    .action(async (project, deploymentRef, opts, cmd) => {
      if (opts.section && !VALID_SECTIONS.includes(opts.section as DashboardSection)) {
        throw new CliError(
          'usage',
          `Invalid section '${opts.section}'. Valid sections are: ${VALID_SECTIONS.join(', ')}.`,
        );
      }

      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { accountId } = await session.credentials();

      let url: string;

      if (deploymentRef) {
        if (/^[0-9a-f]{8}$/i.test(deploymentRef)) {
          const { api } = await pagesApi(session);
          const d = await resolveDeploymentRef(api, project, deploymentRef);
          url = deploymentDashboardUrl(accountId, project, d.id);
        } else {
          url = deploymentDashboardUrl(accountId, project, deploymentRef);
        }
      } else if (opts.section) {
        url = sectionDashboardUrl(accountId, project, opts.section as DashboardSection);
      } else {
        url = projectDashboardUrl(accountId, project);
      }

      if (opts.open) {
        if (ctx.io.stdoutIsTTY && ctx.io.stdinIsTTY && flags.input) {
          await ctx.openUrl(url);
          session.out.note('Opened dashboard in browser.');
        } else {
          session.out.note('--open ignored: not an interactive terminal.');
        }
      }

      session.out.data({ url }, (data) => data.url);
    });
}
