import { CliError } from '../../core/errors.js';
import type { PagesApi } from './api.js';
import { deploymentDashboardUrl } from './dashboard.js';
import type { Deployment, PagesEnv, Project } from './types.js';

export type DeploymentState = 'queued' | 'building' | 'success' | 'failure' | 'canceled' | 'skipped';

const SHORT_ID_REGEX = /^[0-9a-f]{8}$/i;

/**
 * Maps the raw Cloudflare stage fields to a single user-facing state.
 *
 * Rules, evaluated in strict order:
 * 1. `is_skipped` → `skipped`
 * 2. `latest_stage.status` in failure/canceled/skipped → that status
 * 3. `name === 'deploy'` with status `success` → `success`
 * 4. `name === 'queued'` → `queued`
 * 5. any other state → `building`
 */
export function deploymentState(d: Deployment): DeploymentState {
  if (d.is_skipped) return 'skipped';

  const status = d.latest_stage?.status;
  if (status === 'failure' || status === 'canceled' || status === 'skipped') {
    return status;
  }

  const name = d.latest_stage?.name;
  if (name === 'deploy' && status === 'success') {
    return 'success';
  }

  if (name === 'queued') {
    return 'queued';
  }

  return 'building';
}

/** Whether the deployment has reached a terminal state and will not change anymore. */
export function isTerminal(s: DeploymentState): boolean {
  return s === 'success' || s === 'failure' || s === 'canceled' || s === 'skipped';
}

export interface CollectDeploymentsOptions {
  env?: PagesEnv;
  branch?: string;
  limit?: number;
}

/**
 * Paginates up to 8 pages (25 items each) until `limit` is met or `totalPages` is exhausted.
 * Filters by branch using exact match and sorts newest first.
 */
export async function collectDeployments(
  api: PagesApi,
  project: string,
  opts?: CollectDeploymentsOptions,
): Promise<Deployment[]> {
  const limit = opts?.limit;
  const branch = opts?.branch;
  const collected: Deployment[] = [];
  const maxPages = 8;

  for (let page = 1; page <= maxPages; page++) {
    const res = await api.listDeploymentsPage(project, {
      env: opts?.env,
      page,
      perPage: 25,
    });

    for (const d of res.items) {
      if (branch !== undefined) {
        const dBranch = d.deployment_trigger?.metadata?.branch;
        if (dBranch !== branch) continue;
      }
      collected.push(d);
      if (limit !== undefined && collected.length >= limit) {
        break;
      }
    }

    if (limit !== undefined && collected.length >= limit) {
      break;
    }
    if (page >= res.totalPages) {
      break;
    }
  }

  collected.sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
  return limit !== undefined ? collected.slice(0, limit) : collected;
}

/**
 * Returns the newest deployment of each branch, ordered from newest to oldest by `created_on`.
 */
export function latestByBranch(ds: Deployment[]): { branch: string; deployment: Deployment }[] {
  const sorted = [...ds].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));
  const seen = new Set<string>();
  const result: { branch: string; deployment: Deployment }[] = [];

  for (const d of sorted) {
    const branch = d.deployment_trigger?.metadata?.branch;
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    result.push({ branch, deployment: d });
  }

  return result;
}

export interface ResolveDeploymentRefOptions {
  branch?: string;
}

/**
 * Resolves a deployment reference (`undefined`, `'latest'`, 8-hex short id, or full id).
 *
 * - `undefined` or `'latest'`: newest deployment, filtered by branch if provided.
 * - 8 hex characters: looked up among the 100 most recent deployments. Throws `not_found` (exit 4) if missing.
 * - any other string: fetched directly via `getDeployment`.
 */
export async function resolveDeploymentRef(
  api: PagesApi,
  project: string,
  ref: string | undefined,
  opts?: ResolveDeploymentRefOptions,
): Promise<Deployment> {
  if (ref === undefined || ref === 'latest') {
    const list = await collectDeployments(api, project, { branch: opts?.branch, limit: 1 });
    const first = list[0];
    if (!first) {
      throw new CliError(
        'not_found',
        opts?.branch
          ? `No deployments found for branch '${opts.branch}'.`
          : `No deployments found for project '${project}'.`,
      );
    }
    return first;
  }

  if (SHORT_ID_REGEX.test(ref)) {
    const recent = await collectDeployments(api, project, { limit: 100 });
    const match = recent.find((d) => d.short_id.toLowerCase() === ref.toLowerCase());
    if (!match) {
      throw new CliError('not_found', `No deployment with short id '${ref}'.`);
    }
    return match;
  }

  return await api.getDeployment(project, ref);
}

/**
 * Returns the canonical deployment if present, otherwise the newest successful production deployment.
 */
export function currentProductionDeployment(
  project: Project,
  productionDeployments: Deployment[],
): Deployment | undefined {
  if (project.canonical_deployment) {
    return project.canonical_deployment;
  }

  const successful = productionDeployments
    .filter((d) => d.environment === 'production' && deploymentState(d) === 'success')
    .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));

  return successful[0];
}

/**
 * Finds the newest successful production deployment strictly older than `current`, with a different id.
 */
export function findRollbackTarget(productionDeployments: Deployment[], current?: Deployment): Deployment | undefined {
  const currentTime = current ? Date.parse(current.created_on) : Number.POSITIVE_INFINITY;

  const candidates = productionDeployments
    .filter((d) => {
      if (d.environment !== 'production') return false;
      if (deploymentState(d) !== 'success') return false;
      if (current && d.id === current.id) return false;
      if (current && Date.parse(d.created_on) >= currentTime) return false;
      return true;
    })
    .sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on));

  return candidates[0];
}

export interface WaitForDeploymentOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
  onState?: (state: DeploymentState, deployment: Deployment) => void;
}

/**
 * Polls `getDeployment` until a terminal state is reached or timeout occurs.
 * Calls `onState` whenever the deployment state changes.
 */
export async function waitForDeployment(
  api: PagesApi,
  project: string,
  id: string,
  opts?: WaitForDeploymentOptions,
): Promise<Deployment> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = opts?.now ?? (() => Date.now());
  const intervalMs = opts?.intervalMs ?? 5000;
  const timeoutMs = opts?.timeoutMs ?? 1_200_000;
  const onState = opts?.onState;

  const startTime = now();
  let lastState: DeploymentState | undefined;

  while (true) {
    const deployment = await api.getDeployment(project, id);
    const state = deploymentState(deployment);

    if (state !== lastState) {
      onState?.(state, deployment);
      lastState = state;
    }

    if (isTerminal(state)) {
      return deployment;
    }

    if (now() - startTime >= timeoutMs) {
      const hintUrl = deploymentDashboardUrl(api.accountId, project, id);
      throw new CliError('api_error', `Deployment '${id}' timed out after 20 minutes.`, {
        hint: `Check progress on the dashboard: ${hintUrl}`,
      });
    }

    await sleep(intervalMs);

    if (now() - startTime >= timeoutMs) {
      const hintUrl = deploymentDashboardUrl(api.accountId, project, id);
      throw new CliError('api_error', `Deployment '${id}' timed out after 20 minutes.`, {
        hint: `Check progress on the dashboard: ${hintUrl}`,
      });
    }
  }
}
