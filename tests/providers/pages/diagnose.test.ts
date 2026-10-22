import { describe, expect, it } from 'vitest';
import { diagnoseProject } from '../../../src/providers/pages/diagnose.js';
import { makeProject } from '../../fixtures/pages.js';

function codesFor(paths: { path_includes?: string[]; path_excludes?: string[] }): string[] {
  const project = makeProject({ source: { config: paths } });
  return diagnoseProject({ project, deployments: [] }).map((f) => f.code);
}

describe('diagnoseProject watch paths', () => {
  it('the dashboard default (include "*", nothing excluded) is not reported', () => {
    expect(codesFor({ path_includes: ['*'], path_excludes: [] })).not.toContain('watch_paths');
  });

  it('narrower includes are reported', () => {
    expect(codesFor({ path_includes: ['src/**'] })).toContain('watch_paths');
  });

  it('any exclude is reported, even with include "*"', () => {
    expect(codesFor({ path_includes: ['*'], path_excludes: ['docs/**'] })).toContain('watch_paths');
  });
});
