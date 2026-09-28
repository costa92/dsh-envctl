import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { adoptEnvironment } from '../../src/adopt/adopt.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { loadManifest, loadState } from '../../src/manifest/files.js';
import type { CaptureDocument } from '../../src/domain.js';

describe('adoptEnvironment', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-adopt-test-'));
    const webProfile = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams'), { recursive: true });

    fs.writeFileSync(
      path.join(webProfile, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {
          '@nanmicoder/dsh-agent-teams': '^0.1.21'
        },
        dsh: {
          profile: {
            bundles: ['@nanmicoder/dsh-agent-teams']
          }
        }
      })
    );

    fs.writeFileSync(
      path.join(webProfile, 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json'),
      JSON.stringify({
        name: '@nanmicoder/dsh-agent-teams',
        version: '0.1.21',
        _resolved: 'https://registry.npmjs.org/@nanmicoder/dsh-agent-teams/-/dsh-agent-teams-0.1.21.tgz'
      })
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should adopt valid candidate and record ownership in state.json', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const candidate: CaptureDocument = {
      apiVersion: 'dshenv-capture/v1',
      manifest: {
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
      },
      lock: {
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
      },
      warnings: []
    };

    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(
      paths.stateFile,
      JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: '2026-01-01T00:00:00.000Z', appliedLockHash: '', profiles: {}, skills: { wiki: 'd1' } })
    );
    const summary = await adoptEnvironment(paths, candidate);
    expect(summary.adoptedCount).toBe(1);

    // Verify manifest, lock, state written
    expect(fs.existsSync(paths.manifestFile)).toBe(true);
    expect(fs.existsSync(paths.lockFile)).toBe(true);
    expect(fs.existsSync(paths.stateFile)).toBe(true);

    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(state.ownership?.web?.['@nanmicoder/dsh-agent-teams']).toBeDefined();
    expect(state.ownership?.web?.['@nanmicoder/dsh-agent-teams'].package).toBe('@nanmicoder/dsh-agent-teams');
    expect(state.ownership?.web?.['@nanmicoder/dsh-agent-teams'].lockedVersion).toBe('0.1.21');
    expect(state.skills).toEqual({ wiki: 'd1' });
  });

  it('puts the manifest and lock back when writing state.json fails', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(path.dirname(paths.manifestFile), { recursive: true });
    const manifestBefore = 'apiVersion: dshenv/v1\nprofiles: {}\n';
    fs.writeFileSync(paths.manifestFile, manifestBefore);
    const candidate: CaptureDocument = {
      apiVersion: 'dshenv-capture/v1',
      manifest: {
        apiVersion: 'dshenv/v1',
        profiles: {
          web: {
            plugins: {
              'agent-teams': { package: '@nanmicoder/dsh-agent-teams', enabled: true, source: { type: 'npm', version: '0.1.21' } }
            }
          }
        }
      },
      lock: { apiVersion: 'dshenv-lock/v1', profiles: {} },
      warnings: []
    };
    const realRename = fs.promises.rename;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === paths.stateFile) {
        throw new Error('disk full');
      }
      return realRename(from, to);
    });
    try {
      await expect(adoptEnvironment(paths, candidate)).rejects.toThrow(/disk full/);
    } finally {
      spy.mockRestore();
    }

    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(manifestBefore);
    expect(fs.existsSync(paths.lockFile)).toBe(false);
    expect(fs.existsSync(paths.stateFile)).toBe(false);
  });

  it('keeps the declared patches of a plugin the manifest already has', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(path.dirname(paths.manifestFile), { recursive: true });
    fs.writeFileSync(
      paths.manifestFile,
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source: { type: npm, version: "0.1.20" }
        patches:
          - id: teams
            config: { taskPlanning: captain }
`
    );
    const candidate: CaptureDocument = {
      apiVersion: 'dshenv-capture/v1',
      manifest: {
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
      },
      lock: { apiVersion: 'dshenv-lock/v1', profiles: {} },
      warnings: []
    };

    await adoptEnvironment(paths, candidate);

    const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
    expect(manifest.profiles.web.plugins).toEqual({
      teams: {
        package: '@nanmicoder/dsh-agent-teams',
        enabled: true,
        source: { type: 'npm', version: '0.1.21' },
        patches: [{ id: 'teams', config: { taskPlanning: 'captain' } }]
      }
    });
  });

  it('should reject stale candidate when live inventory differs from candidate facts', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const candidate: CaptureDocument = {
      apiVersion: 'dshenv-capture/v1',
      manifest: {
        apiVersion: 'dshenv/v1',
        profiles: {
          web: {
            plugins: {
              'agent-teams': {
                package: '@nanmicoder/dsh-agent-teams',
                enabled: true,
                source: { type: 'npm', version: '0.9.99' } // Mismatched version!
              }
            }
          }
        }
      },
      lock: {
        apiVersion: 'dshenv-lock/v1',
        profiles: {}
      },
      warnings: []
    };

    await expect(adoptEnvironment(paths, candidate)).rejects.toThrow(/stale|mismatch/i);
  });
});
