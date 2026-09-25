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

  it('should plan enable and disable from selection mismatch', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            on: {
              package: 'pkg-on',
              enabled: true,
              source: { type: 'npm', version: '1.0.0' }
            },
            off: {
              package: 'pkg-off',
              enabled: false,
              source: { type: 'npm', version: '1.0.0' }
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
            'pkg-on': {
              name: 'pkg-on',
              installed: true,
              version: '1.0.0',
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: false
            },
            'pkg-off': {
              name: 'pkg-off',
              installed: true,
              version: '1.0.0',
              sourceType: 'npm',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, null, inventory);
    expect(plan.operations.map((op) => op.kind).sort()).toEqual(['disable', 'enable']);
  });

  it('should block unverifiable patches instead of emitting configure', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              enabled: true,
              source: { type: 'npm', version: '0.1.21' },
              patches: [{ id: 'agent-teams', config: { taskPlanning: 'captain' } }]
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

    const plan = buildPlan(manifest, null, inventory);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].kind).toBe('blocked');
    expect(plan.operations.some((op) => op.kind === 'configure')).toBe(false);
  });

  it('should block git plugins whose lock has no commit', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            'git-plug': {
              package: 'git-plug',
              enabled: true,
              source: { type: 'git', url: 'github:example/git-plug' }
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
            'git-plug': {
              name: 'git-plug',
              installed: true,
              version: '0.0.0',
              sourceType: 'git',
              isSymlink: false,
              isExternalSymlink: false,
              enabled: true
            }
          }
        }
      }
    };

    const plan = buildPlan(manifest, null, inventory);
    expect(plan.operations[0]?.kind).toBe('blocked');
  });
});

describe('buildStatus', () => {
  const emptyLock: EnvironmentLock = { apiVersion: 'dshenv-lock/v1', profiles: {} };

  it('should use the seven stable status values', () => {
    const manifest: EnvironmentManifest = { apiVersion: 'dshenv/v1', profiles: {} };
    const inventory: EnvironmentInventory = { profiles: {} };
    const plan = buildPlan(manifest, emptyLock, inventory);
    const summary = buildStatus(manifest, emptyLock, null, inventory, plan);
    expect(summary.status).toBe('healthy');
  });

  it('should map missing manifest to degraded', () => {
    const inventory: EnvironmentInventory = { profiles: {} };
    const plan = buildPlan(null, null, inventory);
    const summary = buildStatus(null, null, null, inventory, plan);
    expect(summary.status).toBe('degraded');
  });

  it('should map unmanaged-only inventory to unmanaged', () => {
    const manifest: EnvironmentManifest = { apiVersion: 'dshenv/v1', profiles: { web: { plugins: {} } } };
    const inventory: EnvironmentInventory = {
      profiles: {
        web: {
          name: 'web',
          path: '/dummy',
          plugins: {
            extra: {
              name: 'extra',
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
    const plan = buildPlan(manifest, emptyLock, inventory);
    const summary = buildStatus(manifest, emptyLock, null, inventory, plan);
    expect(summary.status).toBe('unmanaged');
    expect(summary.plugins.some((p) => p.status === 'unmanaged' && p.package === 'extra')).toBe(true);
  });

  it('should map blocked operations to degraded', () => {
    const manifest: EnvironmentManifest = {
      apiVersion: 'dshenv/v1',
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              enabled: true,
              source: { type: 'npm', version: '0.1.21' },
              patches: [{ id: 'agent-teams', config: { taskPlanning: 'captain' } }]
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
    const plan = buildPlan(manifest, emptyLock, inventory);
    const summary = buildStatus(manifest, emptyLock, null, inventory, plan);
    expect(summary.status).toBe('degraded');
  });
});
