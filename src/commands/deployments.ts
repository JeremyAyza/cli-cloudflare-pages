import { writeFile } from 'node:fs/promises';
import type { Command } from '@commander-js/extra-typings';
import type { Context } from '../core/context.js';
import { CliError } from '../core/errors.js';
import { readGlobalFlags } from '../core/flags.js';
import { renderTable } from '../core/output.js';
import { createSession } from '../core/session.js';
import { relativeTime } from '../core/time.js';
import { projectDashboardUrl } from '../providers/pages/dashboard.js';
import {
  collectDeployments,
  currentProductionDeployment,
  deploymentState,
  findRollbackTarget,
  resolveDeploymentRef,
  waitForDeployment,
} from '../providers/pages/deployments.js';
import type { PagesEnv } from '../providers/pages/types.js';
import { deploymentView } from '../providers/pages/views.js';
import { pagesApi } from './shared.js';

export function registerDeployments(program: Command, ctx: Context): void {
  const deployments = program.command('deployments').description('Manage and view Cloudflare Pages deployments.');

  deployments
    .command('list <project>')
    .description('List recent deployments of a project.')
    .option('--env <env>', 'filter by environment (production | preview)')
    .option('--branch <branch>', 'filter by exact branch name')
    .option('--limit <limit>', 'maximum number of deployments to return', (v) => Number.parseInt(v, 10))
    .action(async (project, opts, cmd) => {
      if (opts.env && opts.env !== 'production' && opts.env !== 'preview') {
        throw new CliError('usage', "Invalid environment: must be 'production' or 'preview'.");
      }

      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api, accountId } = await pagesApi(session);

      const items = await collectDeployments(api, project, {
        env: opts.env as PagesEnv | undefined,
        branch: opts.branch,
        limit: opts.limit,
      });

      const views = items.map((d) => deploymentView(d, accountId));

      session.out.data(views, (ds) => {
        if (ds.length === 0) return `No deployments found for project '${project}'.`;
        const headers = ['ID', 'ENV', 'BRANCH', 'STATE', 'AGE', 'COMMIT'];
        const rows = ds.map((d) => [
          d.shortId,
          d.environment,
          d.branch,
          d.state,
          relativeTime(d.createdOn, ctx.now()),
          d.commit.message.slice(0, 40),
        ]);
        return renderTable(headers, rows);
      });
    });

  deployments
    .command('show <project> <deployment>')
    .description('Show full details for a specific deployment.')
    .action(async (project, deploymentRef, _opts, cmd) => {
      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api, accountId } = await pagesApi(session);

      const d = await resolveDeploymentRef(api, project, deploymentRef);
      const view = deploymentView(d, accountId);

      session.out.data(view, (v) => {
        const lines: string[] = [
          `Deployment: ${v.id} (${v.shortId})`,
          `Project: ${project}`,
          `Environment: ${v.environment}`,
          `Branch: ${v.branch}`,
          `State: ${v.state}`,
          `Created: ${v.createdOn} (${relativeTime(v.createdOn, ctx.now())})`,
          `URL: ${v.url}`,
          `Dashboard: ${v.dashboardUrl}`,
          `Commit: ${v.commit.hash} (${v.commit.shortHash})`,
          `Message: ${v.commit.message}`,
        ];

        if (d.stages && d.stages.length > 0) {
          lines.push('\nStages:');
          for (const s of d.stages) {
            lines.push(`  • ${s.name}: ${s.status}`);
          }
        }

        return lines.join('\n');
      });
    });

  deployments
    .command('logs <project> [deployment]')
    .description('Fetch build logs for a deployment (defaults to latest).')
    .option('--branch <branch>', 'filter to the latest deployment of a specific branch')
    .option('--tail <lines>', 'number of lines from the end to show', (v) => Number.parseInt(v, 10))
    .option('--output <file>', 'save logs to a file instead of writing to stdout')
    .action(async (project, deploymentRef, opts, cmd) => {
      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api } = await pagesApi(session);

      const d = await resolveDeploymentRef(api, project, deploymentRef ?? 'latest', { branch: opts.branch });
      const logs = await api.getDeploymentLogs(project, d.id);

      let lines = logs.data.map((l) => `${l.ts ? `${l.ts} ` : ''}${l.line}`);
      if (opts.tail && opts.tail > 0) {
        lines = lines.slice(-opts.tail);
      }

      if (opts.output) {
        await writeFile(opts.output, `${lines.join('\n')}\n`, 'utf8');
        session.out.note(`Logs saved to ${opts.output} (${lines.length} lines).`);
        return;
      }

      session.out.data(
        {
          deploymentId: d.id,
          total: logs.total,
          lines,
        },
        (data) => data.lines.join('\n'),
      );
    });

  deployments
    .command('redeploy <project>')
    .description('Trigger a new deployment from the head of a branch.')
    .option('--branch <branch>', 'branch to deploy (defaults to project production branch)')
    .option('--wait', 'wait for deployment to finish')
    .action(async (project, opts, cmd) => {
      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api, accountId } = await pagesApi(session);

      const p = await api.getProject(project);
      if (!p.source) {
        throw new CliError(
          'usage',
          `Project '${project}' is a Direct Upload project with no Git repository connected. Use the dashboard to deploy:`,
          { hint: projectDashboardUrl(accountId, project) },
        );
      }

      const branch = opts.branch ?? p.production_branch;
      const env: PagesEnv = branch === p.production_branch ? 'production' : 'preview';

      if (flags.dryRun) {
        const dryResult = { dryRun: true, action: 'redeploy', project, branch, environment: env };
        session.out.data(
          dryResult,
          (r) => `[dry-run] Would trigger redeployment of branch '${r.branch}' on project '${r.project}'.`,
        );
        return;
      }

      await session.confirm({
        level: env,
        project,
        action: `redeploy branch '${branch}'`,
      });

      let d = await api.createDeployment(project, branch);

      if (opts.wait) {
        d = await waitForDeployment(api, project, d.id, {
          sleep: (ms) => ctx.sleep(ms),
          onState: (state) => session.out.note(`Deployment ${d.short_id}: ${state}`),
        });

        if (deploymentState(d) === 'failure') {
          const logs = await api.getDeploymentLogs(project, d.id).catch(() => ({ data: [] }));
          const logTail = logs.data.slice(-15).map((l) => l.line);
          throw new CliError('deployment_failed', `Deployment '${d.id}' failed.`, {
            details: { deploymentId: d.id, state: 'failure', logTail },
          });
        }
      }

      await session.audit({
        command: 'deployments redeploy',
        project,
        env,
        deploymentId: d.id,
        result: 'ok',
      });

      const view = deploymentView(d, accountId);
      session.out.data(
        view,
        (v) => `Triggered deployment ${v.shortId} on branch '${branch}'.\nURL: ${v.url}\nDashboard: ${v.dashboardUrl}`,
      );
    });

  deployments
    .command('retry <project> <deployment>')
    .description('Retry a failed or canceled deployment.')
    .option('--wait', 'wait for deployment to finish')
    .action(async (project, deploymentRef, opts, cmd) => {
      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api, accountId } = await pagesApi(session);

      const d = await resolveDeploymentRef(api, project, deploymentRef);

      if (flags.dryRun) {
        const dryResult = {
          dryRun: true,
          action: 'retry',
          project,
          environment: d.environment,
          target: deploymentView(d, accountId),
        };
        session.out.data(
          dryResult,
          (r) => `[dry-run] Would retry deployment '${r.target.shortId}' on project '${r.project}'.`,
        );
        return;
      }

      await session.confirm({
        level: d.environment,
        project,
        action: `retry deployment '${d.short_id}'`,
      });

      let retried = await api.retryDeployment(project, d.id);

      if (opts.wait) {
        retried = await waitForDeployment(api, project, retried.id, {
          sleep: (ms) => ctx.sleep(ms),
          onState: (state) => session.out.note(`Deployment ${retried.short_id}: ${state}`),
        });

        if (deploymentState(retried) === 'failure') {
          const logs = await api.getDeploymentLogs(project, retried.id).catch(() => ({ data: [] }));
          const logTail = logs.data.slice(-15).map((l) => l.line);
          throw new CliError('deployment_failed', `Deployment '${retried.id}' failed.`, {
            details: { deploymentId: retried.id, state: 'failure', logTail },
          });
        }
      }

      await session.audit({
        command: 'deployments retry',
        project,
        env: d.environment,
        deploymentId: retried.id,
        result: 'ok',
      });

      const view = deploymentView(retried, accountId);
      session.out.data(view, (v) => `Retried deployment ${v.shortId}.\nURL: ${v.url}\nDashboard: ${v.dashboardUrl}`);
    });

  deployments
    .command('rollback <project> [deployment]')
    .description('Rollback production to an earlier successful deployment.')
    .action(async (project, deploymentRef, _opts, cmd) => {
      const flags = readGlobalFlags(cmd, ctx.env);
      const session = createSession(ctx, flags);
      const { api, accountId } = await pagesApi(session);

      let target = deploymentRef ? await resolveDeploymentRef(api, project, deploymentRef) : undefined;

      if (!target) {
        const list = await collectDeployments(api, project, { env: 'production', limit: 25 });
        const p = await api.getProject(project);
        const curr = currentProductionDeployment(p, list);
        target = findRollbackTarget(list, curr);
        if (!target) {
          throw new CliError('not_found', 'No rollback target found for production.');
        }
      }

      if (flags.dryRun) {
        const dryResult = {
          dryRun: true,
          action: 'rollback',
          project,
          environment: 'production',
          target: deploymentView(target, accountId),
        };
        session.out.data(
          dryResult,
          (r) => `[dry-run] Would rollback production to deployment '${r.target.shortId}' on project '${r.project}'.`,
        );
        return;
      }

      await session.confirm({
        level: 'production',
        project,
        action: `rollback production to deployment '${target.short_id}'`,
      });

      const rolled = await api.rollbackDeployment(project, target.id);

      await session.audit({
        command: 'deployments rollback',
        project,
        env: 'production',
        deploymentId: rolled.id,
        result: 'ok',
      });

      const view = deploymentView(rolled, accountId);
      session.out.data(
        view,
        (v) =>
          `Rolled back production to deployment ${v.shortId}.\n` +
          'Warning: The next commit pushed to production branch will deploy over this rollback.\n' +
          `URL: ${v.url}\nDashboard: ${v.dashboardUrl}`,
      );
    });
}
