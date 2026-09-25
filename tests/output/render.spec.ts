import { describe, it, expect } from 'vitest';
import { renderPlan, renderStatus, renderDoctor } from '../../src/output/render.js';
import type { EnvironmentPlan, EnvironmentStatusSummary } from '../../src/planner/plan.js';

describe('renderPlan', () => {
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
      unmanaged: [{ profile: 'web', package: 'extra-pkg' }]
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
        blocked: 0
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
        mutationsSupported: false
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
    expect(text).toContain('Not enabled in prototype');
  });
});
