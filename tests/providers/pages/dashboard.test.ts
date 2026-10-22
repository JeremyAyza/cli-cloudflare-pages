import { afterEach, describe, expect, it } from 'vitest';
import {
  DASH_BASE,
  type DashboardSection,
  deploymentDashboardUrl,
  GITHUB_APP_URL,
  projectDashboardUrl,
  SECTION_PATHS,
  sectionDashboardUrl,
} from '../../../src/providers/pages/dashboard.js';
import { ACCT } from '../../helpers/cf.js';

const SECTIONS: DashboardSection[] = ['deployments', 'settings', 'domains', 'variables', 'builds'];

describe('dashboard urls', () => {
  it('dashboard urls', () => {
    expect(projectDashboardUrl(ACCT, 'my-site')).toBe(`https://dash.cloudflare.com/${ACCT}/pages/view/my-site`);
    expect(deploymentDashboardUrl(ACCT, 'my-site', 'd1')).toBe(
      `https://dash.cloudflare.com/${ACCT}/pages/view/my-site/d1`,
    );
    expect(sectionDashboardUrl(ACCT, 'my-site', 'deployments')).toBe(projectDashboardUrl(ACCT, 'my-site')); // unverified / base → project
    expect(sectionDashboardUrl(ACCT, 'my-site', 'domains')).toBe(`${projectDashboardUrl(ACCT, 'my-site')}/domains`);
    expect(sectionDashboardUrl(ACCT, 'my-site', 'variables')).toBe(
      `${projectDashboardUrl(ACCT, 'my-site')}/settings/production#variables`,
    );
  });

  it('exposes the base URLs', () => {
    expect(DASH_BASE).toBe('https://dash.cloudflare.com');
    expect(GITHUB_APP_URL).toBe('https://github.com/apps/cloudflare-workers-and-pages');
  });

  it('encodes dynamic segments', () => {
    expect(projectDashboardUrl(ACCT, 'my site/x')).toBe(`${DASH_BASE}/${ACCT}/pages/view/my%20site%2Fx`);
    expect(deploymentDashboardUrl(ACCT, 'my-site', 'a/b')).toBe(`${DASH_BASE}/${ACCT}/pages/view/my-site/a%2Fb`);
  });
});

describe('sectionDashboardUrl', () => {
  const original = { ...SECTION_PATHS };
  afterEach(() => {
    Object.assign(SECTION_PATHS, original);
  });

  it('only uses a section path that has been verified; otherwise the project URL', () => {
    const project = projectDashboardUrl(ACCT, 'my-site');
    for (const section of SECTIONS) {
      const path = SECTION_PATHS[section];
      const url = sectionDashboardUrl(ACCT, 'my-site', section);
      expect(url).toBe(path === null ? project : `${project}/${path}`);
    }
  });

  it('appends a known section path to the project URL', () => {
    SECTION_PATHS.settings = 'custom-settings';
    expect(sectionDashboardUrl(ACCT, 'my-site', 'settings')).toBe(
      `${projectDashboardUrl(ACCT, 'my-site')}/custom-settings`,
    );
    expect(sectionDashboardUrl(ACCT, 'my-site', 'deployments')).toBe(projectDashboardUrl(ACCT, 'my-site'));
  });
});
