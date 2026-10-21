import { describe, expect, it } from 'vitest';
import { makeDeployment, makeProject } from '../../fixtures/pages.js';

describe('makeProject', () => {
  it('has the documented defaults', () => {
    const project = makeProject();
    expect(project).toMatchObject({
      name: 'my-site',
      subdomain: 'my-site.pages.dev',
      production_branch: 'main',
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
    });
    expect(project.domains).toContain('my-site.pages.dev');
  });

  it('merges nested objects instead of replacing them', () => {
    const project = makeProject({
      name: 'other',
      source: { config: { repo_name: 'other' } },
      deployment_configs: { production: { env_vars: { A: { type: 'plain_text', value: '1' } } } },
    });
    expect(project.name).toBe('other');
    expect(project.source?.type).toBe('github');
    expect(project.source?.config).toMatchObject({
      owner: 'example-org',
      repo_name: 'other',
      preview_deployment_setting: 'all',
    });
    expect(project.deployment_configs.production?.env_vars).toEqual({ A: { type: 'plain_text', value: '1' } });
    expect(project.deployment_configs.preview?.env_vars).toEqual({});
  });

  it('lets a test null out or remove a branch (env_vars null, no preview, no source)', () => {
    const noPreview = makeProject({ deployment_configs: { preview: undefined } });
    expect(JSON.parse(JSON.stringify(noPreview)).deployment_configs).toEqual({ production: { env_vars: {} } });
    expect(
      makeProject({ deployment_configs: { production: { env_vars: null } } }).deployment_configs.production?.env_vars,
    ).toBeNull();
    expect(makeProject({ source: null }).source).toBeNull();
  });

  it('replaces arrays instead of merging them', () => {
    expect(makeProject({ domains: ['example.com'] }).domains).toEqual(['example.com']);
  });

  it('does not share state between calls', () => {
    const a = makeProject();
    a.deployment_configs.production = { env_vars: { A: { type: 'plain_text', value: '1' } } };
    expect(makeProject().deployment_configs.production?.env_vars).toEqual({});
  });
});

describe('makeDeployment', () => {
  it('has the documented defaults', () => {
    const deployment = makeDeployment();
    expect(deployment).toMatchObject({
      project_name: 'my-site',
      environment: 'production',
      is_skipped: false,
      latest_stage: { name: 'deploy', status: 'success' },
      deployment_trigger: { type: 'github:push', metadata: { branch: 'main', commit_dirty: false } },
    });
    expect(deployment.deployment_trigger.metadata.commit_hash).toMatch(/^[0-9a-f]{40}$/);
    expect(deployment.short_id).toHaveLength(8);
    expect(deployment.id.startsWith(deployment.short_id)).toBe(true);
    expect(new Date(deployment.created_on).toISOString()).toBe(deployment.created_on);
    expect(new Date(deployment.modified_on).toISOString()).toBe(deployment.modified_on);
    expect(deployment.stages.at(-1)).toEqual(deployment.latest_stage);
  });

  it('merges latest_stage and deployment_trigger.metadata', () => {
    const deployment = makeDeployment({
      environment: 'preview',
      latest_stage: { status: 'failure' },
      deployment_trigger: { metadata: { branch: 'refactor/web-docs' } },
    });
    expect(deployment.environment).toBe('preview');
    expect(deployment.latest_stage).toMatchObject({ name: 'deploy', status: 'failure' });
    expect(deployment.deployment_trigger.type).toBe('github:push');
    expect(deployment.deployment_trigger.metadata).toMatchObject({
      branch: 'refactor/web-docs',
      commit_message: expect.any(String),
    });
  });

  it('does not share state between calls', () => {
    const a = makeDeployment();
    a.deployment_trigger.metadata.branch = 'changed';
    a.stages.length = 0;
    const b = makeDeployment();
    expect(b.deployment_trigger.metadata.branch).toBe('main');
    expect(b.stages.length).toBeGreaterThan(0);
  });

  it('can be nested in a project', () => {
    const project = makeProject({ latest_deployment: makeDeployment({ id: 'x'.repeat(8) }) });
    expect(project.latest_deployment?.id).toBe('xxxxxxxx');
  });
});
