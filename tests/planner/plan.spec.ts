import { describe, it, expect } from 'vitest';
import { buildPlan, buildStatus } from '../../src/planner/plan.js';
import type { EnvironmentManifest, EnvironmentLock } from '../../src/domain.js';
import type { EnvironmentInventory } from '../../src/inventory/profile-reader.js';

describe('buildPlan', () => {
  it('should plan install for expected plugins that are not installed', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              enabled: true,
              source: { type: 'npm', version: '0.1.21' }
            }
          }
        }
      }
    };
    const lock: EnvironmentLock = {
      apiVersion: 'dshenv-lock/v1',
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              source: { type: 'npm', resolvedVersion: '0.1.21' }
            }
          }
        }
      }
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy/path',
          plugins: {}
        }
      }
    };

    const plan = buildPlan(manifest, lock, inventory);
    expect(plan.hasChanges).toBe(true);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].kind).toBe('install');
    expect(plan.operations[0].package).toBe('@nanmicoder/dsh-agent-teams');
  });

  it('should classify unmanaged plugins without generating remove operation', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {}
        }
      }
    };
    const lock: EnvironmentLock = {
      apiVersion: 'dshenv-lock/v1',
      profiles: {}
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            'unmanaged-pkg': {
              name: 'unmanaged-pkg',
              installed: true,
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, lock, inventory);
    expect(plan.operations.some((op) => op.kind === ('remove' as any))).toBe(false);
    expect(plan.unmanaged).toHaveLength(1);
    expect(plan.unmanaged[0]).toEqual({
      profile: 'web',
      package: 'unmanaged-pkg'
    });
  });

  it('should plan update when installed version differs from target version', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              enabled: true,
              source: { type: 'npm', version: '0.1.22' }
            }
          }
        }
      }
    };
    const lock: EnvironmentLock = {
      apiVersion: 'dshenv-lock/v1',
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              source: { type: 'npm', resolvedVersion: '0.1.22' }
            }
          }
        }
      }
    };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            '@nanmicoder/dsh-agent-teams': {
              name: '@nanmicoder/dsh-agent-teams',
              installed: true,
              version: '0.1.21',
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, lock, inventory);
    expect(plan.hasChanges).toBe(true);
    expect(plan.operations[0].kind).toBe('update');
    expect(plan.operations[0].currentVersion).toBe('0.1.21');
    expect(plan.operations[0].targetVersion).toBe('0.1.22');
  });
});
