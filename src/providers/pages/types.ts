// Shapes of the Cloudflare Pages API (`pages_*` schemas of the official OpenAPI, `cloudflare/api-schemas`).
// Only the fields the CLI reads are listed. Never print these objects as they come: build a view model first,
// because they carry environment variables (also inside every deployment) and `build_config.web_analytics_token`.

export type PagesEnv = 'production' | 'preview';

/** A variable as the API returns it. The value of a secret is not readable, so it may be missing. */
export type EnvVar = { type: 'plain_text'; value: string } | { type: 'secret_text'; value?: string };

export type EnvVars = Record<string, EnvVar>;

export interface Stage {
  name: string;
  status: string;
  started_on: string | null;
  ended_on: string | null;
}

export interface Deployment {
  id: string;
  short_id: string;
  project_name: string;
  environment: PagesEnv;
  url: string;
  aliases: string[] | null;
  created_on: string;
  modified_on: string;
  is_skipped: boolean;
  skip_reason?: string | null;
  latest_stage: Stage;
  stages: Stage[];
  deployment_trigger: {
    type: string;
    metadata: { branch: string; commit_hash: string; commit_message: string; commit_dirty: boolean };
  };
}

export interface DeploymentConfig {
  /** `null`, or missing, on projects that never had a variable. Treat both as an empty map. */
  env_vars?: Record<string, EnvVar | null> | null;
  wrangler_config_hash?: string | null;
  build_image_major_version?: number | null;
}

export interface SourceConfig {
  owner: string;
  repo_name: string;
  production_deployments_enabled?: boolean;
  preview_deployment_setting?: 'all' | 'none' | 'custom';
  preview_branch_includes?: string[];
  preview_branch_excludes?: string[];
  path_includes?: string[];
  path_excludes?: string[];
}

export interface Project {
  id: string;
  name: string;
  subdomain: string;
  domains: string[];
  production_branch: string;
  created_on: string;
  source?: { type: string; config: SourceConfig } | null;
  build_config?: { build_command?: string | null; destination_dir?: string | null; root_dir?: string | null } | null;
  /** Projects that never had a preview deployment may have no `preview` entry. */
  deployment_configs: { production?: DeploymentConfig; preview?: DeploymentConfig };
  latest_deployment?: Deployment | null;
  canonical_deployment?: Deployment | null;
}

export interface DeploymentLogs {
  total: number;
  includes_container_logs: boolean;
  data: { ts: string; line: string }[];
}

export interface Domain {
  name: string;
  status: string;
  validation_data?: { status?: string; method?: string; error_message?: string } | null;
}

/** What `PATCH` accepts per variable: a value to set, or `null` to delete it. Keys that are not sent stay as they are. */
export type EnvVarPatch = Record<string, { type: 'plain_text' | 'secret_text'; value: string } | null>;
