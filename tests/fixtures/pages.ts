import type { Deployment, Project, Stage } from '../../src/providers/pages/types.js';

// Pages API fixtures. Generic names only: `my-site`, `example-org`.

/** Like `Partial`, but at every level of nested objects. Arrays are replaced as a whole. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Overrides win. Plain objects present on both sides are merged key by key; arrays, `null` and scalars replace.
 * A key whose override is `undefined` is set to `undefined`, so it disappears from the JSON a test sends
 * (`{ deployment_configs: { preview: undefined } }` makes a project without a preview entry).
 */
function merge<T extends object>(base: T, overrides: unknown): T {
  if (!isPlainObject(overrides)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? merge(current, value) : value;
  }
  return out as T;
}

const NOW = '2026-10-20T12:00:00.000Z';
const COMMIT = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const DEPLOYMENT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

/** A project with a GitHub source and empty variables in both environments. */
export function makeProject(overrides: DeepPartial<Project> = {}): Project {
  return merge<Project>(
    {
      id: '5f1e7a0c-0000-4000-8000-000000000001',
      name: 'my-site',
      subdomain: 'my-site.pages.dev',
      domains: ['my-site.pages.dev'],
      production_branch: 'main',
      created_on: NOW,
      source: {
        type: 'github',
        config: {
          owner: 'example-org',
          repo_name: 'my-site',
          production_deployments_enabled: true,
          preview_deployment_setting: 'all',
        },
      },
      deployment_configs: { production: { env_vars: {} }, preview: { env_vars: {} } },
    },
    overrides,
  );
}

function stage(name: string): Stage {
  return { name, status: 'success', started_on: NOW, ended_on: NOW };
}

/** A successful production deployment of `main`. For another outcome, override `latest_stage` and `stages` together. */
export function makeDeployment(overrides: DeepPartial<Deployment> = {}): Deployment {
  return merge<Deployment>(
    {
      id: DEPLOYMENT_ID,
      short_id: DEPLOYMENT_ID.slice(0, 8),
      project_name: 'my-site',
      environment: 'production',
      url: 'https://a1b2c3d4.my-site.pages.dev',
      aliases: ['https://main.my-site.pages.dev'],
      created_on: NOW,
      modified_on: NOW,
      is_skipped: false,
      latest_stage: stage('deploy'),
      stages: ['queued', 'initialize', 'clone_repo', 'build', 'deploy'].map(stage),
      deployment_trigger: {
        type: 'github:push',
        metadata: { branch: 'main', commit_hash: COMMIT, commit_message: 'Update index.html', commit_dirty: false },
      },
    },
    overrides,
  );
}
