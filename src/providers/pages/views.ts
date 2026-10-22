import { deploymentDashboardUrl, projectDashboardUrl } from './dashboard.js';
import { type DeploymentState, deploymentState, latestByBranch } from './deployments.js';
import type { Finding } from './diagnose.js';
import type { Deployment, Domain, PagesEnv, Project } from './types.js';

export interface DeploymentView {
  id: string;
  shortId: string;
  environment: PagesEnv;
  branch: string;
  commit: {
    hash: string;
    shortHash: string;
    message: string;
  };
  state: DeploymentState;
  skipReason: string | null;
  createdOn: string;
  url: string;
  aliases: string[];
  dashboardUrl: string;
}

export interface ProjectSummaryView {
  name: string;
  subdomain: string;
  domains: string[];
  productionBranch: string;
  repo: string | null;
  production: DeploymentView | null;
  dashboardUrl: string;
}

export interface DomainView {
  name: string;
  status: string;
  error?: string | null;
}

export interface ProjectDetailView {
  name: string;
  subdomain: string;
  productionBranch: string;
  repo: string | null;
  dashboardUrl: string;
  production: DeploymentView | null;
  git: {
    provider: string;
    repo: string;
    productionDeploymentsEnabled: boolean;
    previewSetting: 'all' | 'none' | 'custom';
    previewIncludes: string[];
    previewExcludes: string[];
    pathIncludes: string[];
    pathExcludes: string[];
  } | null;
  build: {
    command: string | null;
    outputDir: string | null;
    rootDir: string | null;
    imageVersion: number | null;
  };
  wranglerManaged: boolean;
  domains: DomainView[];
  latestByBranch: DeploymentView[];
  findings: Finding[];
}

export function deploymentView(d: Deployment, acct: string): DeploymentView {
  const meta = d.deployment_trigger?.metadata;
  const hash = meta?.commit_hash ?? '';
  return {
    id: d.id,
    shortId: d.short_id,
    environment: d.environment,
    branch: meta?.branch ?? '',
    commit: {
      hash,
      shortHash: hash.slice(0, 7),
      message: meta?.commit_message ?? '',
    },
    state: deploymentState(d),
    skipReason: d.skip_reason ?? null,
    createdOn: d.created_on,
    url: d.url,
    aliases: d.aliases ?? [],
    dashboardUrl: deploymentDashboardUrl(acct, d.project_name, d.id),
  };
}

export function projectSummaryView(p: Project, acct: string): ProjectSummaryView {
  const src = p.source?.config;
  const repo = src?.owner && src?.repo_name ? `${src.owner}/${src.repo_name}` : null;
  const prodDeploy = p.canonical_deployment ?? p.latest_deployment ?? null;

  return {
    name: p.name,
    subdomain: p.subdomain,
    domains: p.domains ?? [],
    productionBranch: p.production_branch,
    repo,
    production: prodDeploy ? deploymentView(prodDeploy, acct) : null,
    dashboardUrl: projectDashboardUrl(acct, p.name),
  };
}

export function projectDetailView(
  p: Project,
  domains: Domain[],
  deployments: Deployment[],
  findings: Finding[],
  wranglerManaged: boolean,
  acct: string,
): ProjectDetailView {
  const summary = projectSummaryView(p, acct);
  const src = p.source;
  const cfg = src?.config;

  const git =
    src && cfg
      ? {
          provider: src.type ?? 'github',
          repo: `${cfg.owner}/${cfg.repo_name}`,
          productionDeploymentsEnabled: cfg.production_deployments_enabled !== false,
          previewSetting: cfg.preview_deployment_setting ?? 'all',
          previewIncludes: cfg.preview_branch_includes ?? [],
          previewExcludes: cfg.preview_branch_excludes ?? [],
          pathIncludes: cfg.path_includes ?? [],
          pathExcludes: cfg.path_excludes ?? [],
        }
      : null;

  const buildConfig = p.build_config;
  const build = {
    command: buildConfig?.build_command ?? null,
    outputDir: buildConfig?.destination_dir ?? null,
    rootDir: buildConfig?.root_dir ?? null,
    imageVersion: p.deployment_configs.production?.build_image_major_version ?? null,
  };

  const domainViews: DomainView[] = domains.map((d) => ({
    name: d.name,
    status: d.status,
    ...(d.validation_data?.error_message ? { error: d.validation_data.error_message } : {}),
  }));

  const branchDeployments = latestByBranch(deployments)
    .slice(0, 10)
    .map((b) => deploymentView(b.deployment, acct));

  return {
    name: summary.name,
    subdomain: summary.subdomain,
    productionBranch: summary.productionBranch,
    repo: summary.repo,
    dashboardUrl: summary.dashboardUrl,
    production: summary.production,
    git,
    build,
    wranglerManaged,
    domains: domainViews,
    latestByBranch: branchDeployments,
    findings,
  };
}
