import type { ApiClient } from '../../core/http/client.js';
import type { Deployment, DeploymentLogs, Domain, EnvVarPatch, PagesEnv, Project } from './types.js';

/** The API's own page size for `listProjects`; the loop stops at the `total_pages` the API reports. */
const PROJECTS_PER_PAGE = 10;

const enc = encodeURIComponent;

/**
 * One method per Pages endpoint, nothing more: no caching, no filtering, no retries (the client owns those).
 * Every path segment that comes from a project name or an id goes through `encodeURIComponent`.
 */
export class PagesApi {
  readonly #client: ApiClient;
  readonly #accountId: string;

  constructor(client: ApiClient, accountId: string) {
    this.#client = client;
    this.#accountId = accountId;
  }

  #projects(): string {
    return `/accounts/${enc(this.#accountId)}/pages/projects`;
  }

  #project(name: string): string {
    return `${this.#projects()}/${enc(name)}`;
  }

  #deployment(name: string, id: string): string {
    return `${this.#project(name)}/deployments/${enc(id)}`;
  }

  /** Checks the account and the read permission: `GET /pages/projects?per_page=1`. Fails with the API's error. */
  async probe(): Promise<void> {
    await this.#client.request<unknown>({ method: 'GET', path: this.#projects(), query: { per_page: 1 } });
  }

  async listProjects(): Promise<Project[]> {
    const projects: Project[] = [];
    for (let page = 1; ; page++) {
      const { result, resultInfo } = await this.#client.request<Project[]>({
        method: 'GET',
        path: this.#projects(),
        query: { page, per_page: PROJECTS_PER_PAGE },
      });
      projects.push(...result);
      // No `result_info` means there is nothing to paginate.
      if (page >= (resultInfo?.total_pages ?? 1)) return projects;
    }
  }

  async getProject(name: string): Promise<Project> {
    return (await this.#client.request<Project>({ method: 'GET', path: this.#project(name) })).result;
  }

  async listDeploymentsPage(
    name: string,
    opts: { env?: PagesEnv; page: number; perPage: number },
  ): Promise<{ items: Deployment[]; totalPages: number }> {
    const { result, resultInfo } = await this.#client.request<Deployment[]>({
      method: 'GET',
      path: `${this.#project(name)}/deployments`,
      query: { env: opts.env, page: opts.page, per_page: opts.perPage },
    });
    return { items: result, totalPages: resultInfo?.total_pages ?? 1 };
  }

  async getDeployment(name: string, id: string): Promise<Deployment> {
    return (await this.#client.request<Deployment>({ method: 'GET', path: this.#deployment(name, id) })).result;
  }

  async getDeploymentLogs(name: string, id: string): Promise<DeploymentLogs> {
    return (
      await this.#client.request<DeploymentLogs>({
        method: 'GET',
        path: `${this.#deployment(name, id)}/history/logs`,
      })
    ).result;
  }

  /** Builds the head of `branch`. The branch goes out as a multipart field, raw: `refactor/web-docs` is not encoded. */
  async createDeployment(name: string, branch: string): Promise<Deployment> {
    return (
      await this.#client.request<Deployment>({
        method: 'POST',
        path: `${this.#project(name)}/deployments`,
        form: { branch },
      })
    ).result;
  }

  async retryDeployment(name: string, id: string): Promise<Deployment> {
    return (await this.#client.request<Deployment>({ method: 'POST', path: `${this.#deployment(name, id)}/retry` }))
      .result;
  }

  async rollbackDeployment(name: string, id: string): Promise<Deployment> {
    return (await this.#client.request<Deployment>({ method: 'POST', path: `${this.#deployment(name, id)}/rollback` }))
      .result;
  }

  /**
   * Merges `patch` into the variables of one environment: keys that are not in the patch stay, `null` deletes a key.
   * It never reads the project first. Sending back the whole map would blank every secret, whose value cannot be read.
   * `wranglerConfigHash` is forwarded like Wrangler does, so a project managed by a `wrangler` file keeps its hash.
   */
  async patchEnvVars(
    name: string,
    env: PagesEnv,
    patch: EnvVarPatch,
    opts?: { wranglerConfigHash?: string | null },
  ): Promise<Project> {
    const hash = opts?.wranglerConfigHash;
    return (
      await this.#client.request<Project>({
        method: 'PATCH',
        path: this.#project(name),
        json: { deployment_configs: { [env]: { env_vars: patch, ...(hash ? { wrangler_config_hash: hash } : {}) } } },
      })
    ).result;
  }

  async listDomains(name: string): Promise<Domain[]> {
    return (await this.#client.request<Domain[]>({ method: 'GET', path: `${this.#project(name)}/domains` })).result;
  }
}
