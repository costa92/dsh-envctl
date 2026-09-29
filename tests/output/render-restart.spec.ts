import { describe, it, expect } from 'vitest';
import { renderPlan, renderRestartSummary } from '../../src/output/render.js';
import type { EnvironmentPlan } from '../../src/planner/plan.js';
import type { RestartSummary } from '../../src/apply/restart-plan.js';

const summary: RestartSummary = {
  notRequired: [{ profile: 'web', package: 'agent-teams', kind: 'enable', reason: 'hmr-on' }],
  required: [
    { profile: 'web', package: 'shared-plugin', kind: 'update', reason: 'package-update' },
    { profile: 'cli', package: 'tool-x', kind: 'install', reason: 'hmr-off' },
    { profile: 'api', package: 'tool-y', kind: 'disable', reason: 'hmr-unknown', detail: 'DSH CLI was not found' }
  ]
};

describe('renderRestartSummary', () => {
  it('groups operations and asks to run dshenv mark-restarted', () => {
    expect(renderRestartSummary(summary)).toBe(
      [
        'No restart needed:',
        '  [web] enable agent-teams',
        'Restart DSH to load:',
        '  [web] update shared-plugin (package updates are not hot-reloaded)',
        '  [cli] install tool-x (hot reload is off for profile cli)',
        '  [api] disable tool-y (hot reload state of profile api is unknown: DSH CLI was not found)',
        'Then run: dshenv mark-restarted',
        ''
      ].join('\n')
    );
  });

  it('names the profile patch block the way plan does', () => {
    expect(renderRestartSummary({ notRequired: [{ profile: 'web', package: '@profile', kind: 'configure', reason: 'hmr-on' }], required: [] })).toBe(
      'No restart needed:\n  [web] configure profile patches\n'
    );
  });

  it('omits the restart group and the Then run line when nothing needs a restart', () => {
    expect(renderRestartSummary({ notRequired: summary.notRequired, required: [] })).toBe(
      'No restart needed:\n  [web] enable agent-teams\n'
    );
  });

  it('omits the no-restart group when everything needs a restart', () => {
    const text = renderRestartSummary({ notRequired: [], required: summary.required });
    expect(text).not.toContain('No restart needed:');
    expect(text.startsWith('Restart DSH to load:\n')).toBe(true);
  });
});

describe('renderPlan with a restart summary', () => {
  const plan: EnvironmentPlan = {
    hasChanges: true,
    operations: [
      { kind: 'enable', profile: 'web', alias: 'teams', package: 'agent-teams', reason: 'enable', targetEnabled: true },
      { kind: 'update', profile: 'web', alias: 'shared', package: 'shared-plugin', reason: 'update', currentVersion: '1.0.0', targetVersion: '1.1.0' }
    ],
    unmanaged: [],
      unverified: [],
      unmanagedPatches: [],
      skillOperations: [],
      unmanagedSkills: []
  };

  it('annotates each operation', () => {
    const text = renderPlan(plan, summary);
    expect(text).toContain('  ^ [web] agent-teams (teams) enabled: true (no restart)\n');
    expect(text).toContain('  ~ [web] shared-plugin (shared) 1.0.0 -> 1.1.0 (restart required: package updates are not hot-reloaded)\n');
  });

  it('is unchanged without a summary', () => {
    expect(renderPlan(plan)).not.toContain('restart');
  });
});
