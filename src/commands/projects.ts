import type { Command } from '@commander-js/extra-typings';
import type { Context } from '../core/context.js';
import { CliError } from '../core/errors.js';
import { readGlobalFlags } from '../core/flags.js';
import { renderTable } from '../core/output.js';
import { createSession } from '../core/session.js';
import { relativeTime } from '../core/time.js';
import { collectDeployments } from '../providers/pages/deployments.js';
import { diagnoseProject, isWranglerManaged } from '../providers/pages/diagnose.js';
import { projectDetailView, projectSummaryView } from '../providers/pages/views.js';
import { pagesApi } from './shared.js';

export function registerProjects(program: Command, ctx: Context): void {
  const projects = program.command('projects').description('View Cloudflare Pages projects.');

  projects
    .command('list')
    .description('List all Pages projects in the current account.')
    .action(async (_opts, cmd) => {
      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api, accountId } = await pagesApi(session);

      const list = await api.listProjects();
      const summaries = list.map((p) => projectSummaryView(p, accountId));

      session.out.data(summaries, (items) => {
        if (items.length === 0) return 'No projects found in this account.';
        const headers = ['NAME', 'SUBDOMAIN', 'REPO', 'PRODUCTION', 'DASHBOARD'];
        const rows = items.map((p) => [
          p.name,
          p.subdomain,
          p.repo ?? 'Direct Upload',
          p.production ? `${p.production.state} (${relativeTime(p.production.createdOn, ctx.now())})` : '-',
          p.dashboardUrl,
        ]);
        return renderTable(headers, rows);
      });
    });

  projects
    .command('show <project>')
    .description('Show full details and diagnostics for a Pages project.')
    .option('--expect <sha>', 'check whether a commit hash triggered a deployment (at least 7 hex chars)')
    .option('--branch <branch>', 'branch to filter with --expect (defaults to production branch)')
    .action(async (project, opts, cmd) => {
      if (opts.expect && !/^[0-9a-f]{7,40}$/i.test(opts.expect)) {
        throw new CliError('usage', '--expect must be a commit hash (at least 7 hex characters).');
      }

      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api, accountId } = await pagesApi(session);

      const p = await api.getProject(project);
      const domains = await api.listDomains(project);
      const deployments = await collectDeployments(api, project, { limit: 25 });
      const wranglerManaged = isWranglerManaged(p);

      const findings = diagnoseProject({
        project: p,
        deployments,
        expect: opts.expect ? { sha: opts.expect, branch: opts.branch } : undefined,
      });

      const detail = projectDetailView(p, domains, deployments, findings, wranglerManaged, accountId);

      session.out.data(detail, (d) => {
        const lines: string[] = [
          `Project: ${d.name}`,
          `Subdomain: https://${d.subdomain}`,
          `Production Branch: ${d.productionBranch}`,
          `Dashboard: ${d.dashboardUrl}`,
        ];

        if (d.git) {
          lines.push(`\nGit Source: ${d.git.repo} (${d.git.provider})`);
          lines.push(`  Production deployments enabled: ${d.git.productionDeploymentsEnabled}`);
          lines.push(`  Preview setting: ${d.git.previewSetting}`);
        } else {
          lines.push('\nSource: Direct Upload (no git connected)');
        }

        if (d.findings.length > 0) {
          lines.push('\nFindings & Diagnostics:');
          for (const f of d.findings) {
            lines.push(`  [${f.level}] ${f.message}`);
            if (f.hint) {
              lines.push(`    hint: ${f.hint}`);
            }
          }
        }

        if (d.latestByBranch.length > 0) {
          lines.push('\nLatest Deployments by Branch:');
          for (const b of d.latestByBranch) {
            lines.push(
              `  • ${b.branch}: ${b.shortId} (${b.state}, ${relativeTime(b.createdOn, ctx.now())}) - ${b.commit.message}`,
            );
          }
        }

        return lines.join('\n');
      });
    });
}
