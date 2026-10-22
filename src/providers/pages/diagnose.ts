import { GITHUB_APP_URL } from './dashboard.js';
import { deploymentState } from './deployments.js';
import type { Deployment, Project } from './types.js';

export type FindingCode =
  | 'no_git_source'
  | 'production_deployments_disabled'
  | 'preview_deployments_disabled'
  | 'preview_branches_filtered'
  | 'watch_paths'
  | 'wrangler_config_managed'
  | 'skipped'
  | 'latest_failed'
  | 'expect_found'
  | 'expect_missing';

export interface Finding {
  level: 'info' | 'warning';
  code: FindingCode;
  message: string;
  hint?: string;
}

export const SKIP_REASON_TEXT: Record<string, string> = {
  commit_message: 'skipped because the commit message contains a skip flag such as [skip ci] or [CF-Pages-Skip]',
  preview_deployments_disabled: 'skipped because preview deployments are disabled',
  production_deployments_disabled: 'skipped because production deployments are disabled',
  path_config: 'skipped by build watch paths (no matching files changed)',
  branch_config: 'skipped by branch deployment controls',
};

/** Checks whether a project has a wrangler configuration file managing its settings. */
export function isWranglerManaged(p: Project): boolean {
  const prodHash = p.deployment_configs.production?.wrangler_config_hash;
  const prevHash = p.deployment_configs.preview?.wrangler_config_hash;
  return Boolean((prodHash && prodHash.length > 0) || (prevHash && prevHash.length > 0));
}

export interface DiagnoseProjectOptions {
  project: Project;
  deployments: Deployment[];
  expect?: {
    sha: string;
    branch?: string;
  };
}

export function diagnoseProject({ project, deployments, expect }: DiagnoseProjectOptions): Finding[] {
  const findings: Finding[] = [];
  const src = project.source?.config;

  if (!project.source || !src) {
    findings.push({
      level: 'warning',
      code: 'no_git_source',
      message: 'Project is a Direct Upload (not connected to a Git repository).',
    });
  } else {
    if (src.production_deployments_enabled === false) {
      findings.push({
        level: 'warning',
        code: 'production_deployments_disabled',
        message: 'Automatic production deployments are disabled for this project.',
      });
    }

    if (src.preview_deployment_setting === 'none') {
      findings.push({
        level: 'warning',
        code: 'preview_deployments_disabled',
        message: 'Preview deployments are disabled for all branches.',
      });
    } else if (
      src.preview_deployment_setting === 'custom' &&
      ((src.preview_branch_includes && src.preview_branch_includes.length > 0) ||
        (src.preview_branch_excludes && src.preview_branch_excludes.length > 0))
    ) {
      findings.push({
        level: 'info',
        code: 'preview_branches_filtered',
        message: 'Preview deployments are filtered by branch rules.',
      });
    }

    if ((src.path_includes && src.path_includes.length > 0) || (src.path_excludes && src.path_excludes.length > 0)) {
      findings.push({
        level: 'info',
        code: 'watch_paths',
        message: 'Build watch paths are active: commits touching other paths will not trigger deployments.',
      });
    }
  }

  if (isWranglerManaged(project)) {
    findings.push({
      level: 'info',
      code: 'wrangler_config_managed',
      message: 'Project settings may be managed by a wrangler configuration file.',
    });
  }

  const skipped = deployments.find((d) => d.is_skipped);
  if (skipped) {
    const branch = skipped.deployment_trigger?.metadata?.branch ?? '';
    const hash = skipped.deployment_trigger?.metadata?.commit_hash ?? '';
    const shortHash = hash.slice(0, 7);
    const reasonText =
      (skipped.skip_reason ? SKIP_REASON_TEXT[skipped.skip_reason] : undefined) ??
      (skipped.skip_reason ? `skipped because ${skipped.skip_reason}` : 'skipped');

    findings.push({
      level: 'info',
      code: 'skipped',
      message: `Deployment ${skipped.short_id} (${branch} ${shortHash}) was ${reasonText}.`,
    });
  }

  const latest = deployments[0];
  if (latest && deploymentState(latest) === 'failure') {
    const branch = latest.deployment_trigger?.metadata?.branch ?? '';
    findings.push({
      level: 'warning',
      code: 'latest_failed',
      message: `Latest deployment on '${branch}' failed.`,
      hint: `cf-pages deployments logs ${project.name} ${latest.short_id}`,
    });
  }

  if (expect) {
    const targetBranch = expect.branch ?? project.production_branch;
    const match = deployments.find((d) => {
      const h = d.deployment_trigger?.metadata?.commit_hash;
      if (!h) return false;
      if (expect.branch && d.deployment_trigger?.metadata?.branch !== expect.branch) return false;
      return h.toLowerCase().startsWith(expect.sha.toLowerCase());
    });

    if (match) {
      findings.push({
        level: 'info',
        code: 'expect_found',
        message: `Found deployment ${match.short_id} for commit ${expect.sha.slice(0, 7)} (state: ${deploymentState(match)}).`,
      });
    } else {
      const isProd = targetBranch === project.production_branch;
      const prodDisabled = src?.production_deployments_enabled === false;
      if (!(isProd && prodDisabled)) {
        findings.push({
          level: 'warning',
          code: 'expect_missing',
          message: `No deployment found for commit ${expect.sha.slice(0, 7)} on ${targetBranch}.`,
          hint: `Trigger manually with: cf-pages deployments redeploy ${project.name} --branch ${targetBranch}. Check the GitHub integration at: ${GITHUB_APP_URL}`,
        });
      }
    }
  }

  return findings;
}
