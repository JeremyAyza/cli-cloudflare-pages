export const DASH_BASE = 'https://dash.cloudflare.com';

/** Where to reconnect the Git integration. Verified in Task 17. */
export const GITHUB_APP_URL = 'https://github.com/apps/cloudflare-workers-and-pages';

export type DashboardSection = 'deployments' | 'settings' | 'domains' | 'variables' | 'builds';

/**
 * Path of each section below the project URL, without a leading slash. `null` means the path is not verified against
 * a real account yet, so the project URL is used instead. Task 17 fills in the ones it confirms.
 */
export const SECTION_PATHS: Record<DashboardSection, string | null> = {
  deployments: null,
  settings: null,
  domains: null,
  variables: null,
  builds: null,
};

const enc = encodeURIComponent;

export function projectDashboardUrl(acct: string, project: string): string {
  return `${DASH_BASE}/${enc(acct)}/pages/view/${enc(project)}`;
}

export function deploymentDashboardUrl(acct: string, project: string, id: string): string {
  return `${projectDashboardUrl(acct, project)}/${enc(id)}`;
}

export function sectionDashboardUrl(acct: string, project: string, section: DashboardSection): string {
  const path = SECTION_PATHS[section];
  const base = projectDashboardUrl(acct, project);
  return path === null ? base : `${base}/${path}`;
}
