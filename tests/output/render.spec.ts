import { describe, it, expect } from 'vitest';
import { renderPlan, renderStatus, renderDoctor } from '../../src/output/render.js';
import type { EnvironmentPlan, EnvironmentStatusSummary } from '../../src/planner/plan.js';

describe('renderPlan', () => {
  it('shows no version for installs and source switches that have none', () => {
    const text = renderPlan({
      hasChanges: true,
      operations: [
        { kind: 'install', profile: 'web', alias: 'linked', package: 'linked-pkg', reason: 'missing' },
        { kind: 'update', profile: 'web', alias: 'moved', package: 'moved-pkg', reason: 'Source type changed: installed npm != declared git' }
      ],
      unmanaged: [],
      unverified: [],
      unmanagedPatches: []
    });
    expect(text).not.toMatch(/latest|\? -> \?/);
    expect(text).toContain('  + [web] linked-pkg (linked)\n');
    expect(text).toContain('  ~ [web] moved-pkg (moved)\n');
  });

  it('lists plugins whose local source could not be checked', () => {
    const text = renderPlan({
      hasChanges: false,
      operations: [],
      unmanaged: [],
      unverified: [{ profile: 'web', alias: 'demo', package: 'demo-plugin', reason: 'Local source /src/demo cannot be read' }],
      unmanagedPatches: []
    });
    expect(text).toContain('Unverified plugins');
    expect(text).toContain('  ! [web] demo-plugin (demo): Local source /src/demo cannot be read\n');
    expect(text).not.toContain('in sync');
  });

  it('should render install, blocked, and unmanaged with text symbols', () => {
    const plan: EnvironmentPlan = {
      hasChanges: true,
      operations: [
        {
          kind: 'install',
          profile: 'web',
          alias: 'agent-teams',
          package: '@nanmicoder/dsh-agent-teams',
          reason: 'missing',
          targetVersion: '0.1.21'
        },
        {
          kind: 'blocked',
          profile: 'web',
          alias: 'patched',
          package: 'patched-pkg',
          reason: 'patch evidence missing',
          blockedReason: 'patch evidence missing'
        }
      ],
      unmanaged: [{ profile: 'web', package: 'extra-pkg' }],
      unverified: [],
      unmanagedPatches: []
    };

    const text = renderPlan(plan);
    expect(text).toContain('+ [web] @nanmicoder/dsh-agent-teams');
    expect(text).toContain('! [web] patched-pkg');
    expect(text).toContain('? [web] extra-pkg');
    expect(text.toLowerCase()).not.toContain('remove');
  });
});

describe('renderStatus', () => {
  it('should print a stable status value as text', () => {
    const summary: EnvironmentStatusSummary = {
      status: 'healthy',
      hasChanges: false,
      operationCounts: {
        install: 0,
        update: 0,
        enable: 0,
        disable: 0,
        configure: 0,
        blocked: 0,
        remove: 0
      },
      unmanagedCount: 0,
      profilesCount: 1,
      plugins: []
    };
    expect(renderStatus(summary)).toContain('Environment Status: healthy');
  });
});

describe('renderDoctor', () => {
  it('should render version and omit unique color-only meaning', () => {
    const text = renderDoctor({
      runtime: {
        command: 'dsh',
        version: '0.1.7-rc.2',
        discoverySupported: true,
        mutationsSupported: false,
        capabilities: {
          discovery: { status: 'available', source: 'dshenv' },
          packageOperations: { status: 'disabled', source: 'operations-export', reason: 'Official operations export was not verified' },
          bundleSelection: { status: 'requires-live-service', source: 'live-service' },
          entryToggle: { status: 'requires-live-service', source: 'live-service' },
          configurationValidation: { status: 'disabled', source: 'static-matrix' },
          environmentMutation: { status: 'disabled', source: 'dshenv' },
          operationsExport: '@deepseek-ai/dsh-plugin-manager/operations',
          mutations: false
        }
      },
      paths: {
        home: '/tmp/dsh',
        managerDir: '/tmp/dsh/envctl',
        manifestExists: false,
        lockExists: false,
        stateExists: false
      }
    });
    expect(text).toContain('0.1.7-rc.2');
    expect(text).toContain('Mutation Capability: Planned apply steps only (no general environment mutation)');
    expect(text).not.toContain('read-only mode');
    expect(text).toContain('Capability details:');
    expect(text).toContain('packageOperations: disabled (source: operations-export; reason: Official operations export was not verified)');
    expect(text).toContain('bundleSelection: requires-live-service (source: live-service; reason: none)');
    expect(text).toContain('environmentMutation: disabled (source: dshenv; reason: none)');
  });
});
