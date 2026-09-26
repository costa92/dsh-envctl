import { describe, it, expect } from 'vitest';
import { mergeManifest } from '../../src/overlay/merge.js';
import type { EnvironmentManifest, EnvironmentOverlay } from '../../src/domain.js';

const base = (): EnvironmentManifest => ({
  apiVersion: 'dshenv/v1',
  environment: { harness: { sourceDir: '/base/harness', allowUntestedVersion: false } },
  profiles: {
    web: {
      plugins: {
        teams: {
          package: 'teams-plugin',
          enabled: true,
          source: { type: 'npm', version: '1.0.0' },
          patches: [{ id: 'teams', config: { mode: 'captain', limits: { max: 3, min: 1 } } }]
        },
        heavy: { package: 'heavy-plugin', enabled: true, source: { type: 'npm', version: '1.0.0' } }
      }
    }
  }
});
const overlay = (profiles: EnvironmentOverlay['profiles'], environment?: EnvironmentOverlay['environment']): EnvironmentOverlay => ({
  apiVersion: 'dshenv-overlay/v1',
  ...(environment ? { environment } : {}),
  profiles
});

describe('mergeManifest', () => {
  it('keeps the base untouched when the overlay is empty', () => {
    const { manifest, provenance } = mergeManifest(base(), overlay(undefined), 'laptop');
    expect(manifest).toEqual(base());
    expect(provenance.web.teams).toEqual({ origin: 'base', overridden: [] });
  });

  it('adds new plugins and profiles with overlay origin', () => {
    const { manifest, provenance } = mergeManifest(
      base(),
      overlay({
        web: { plugins: { extra: { package: 'extra-plugin', source: { type: 'npm', version: '2.0.0' } } } },
        cli: { plugins: { tool: { package: 'tool-plugin', source: { type: 'npm', version: '1.0.0' } } } }
      }),
      'laptop'
    );
    expect(manifest.profiles.web.plugins.extra).toEqual({
      package: 'extra-plugin',
      enabled: true,
      source: { type: 'npm', version: '2.0.0' }
    });
    expect(manifest.profiles.cli.plugins.tool.package).toBe('tool-plugin');
    expect(provenance.web.extra).toEqual({ origin: 'overlay:laptop', overridden: [] });
    expect(provenance.cli.tool.origin).toBe('overlay:laptop');
  });

  it('overrides enabled and replaces source wholesale', () => {
    const { manifest, provenance } = mergeManifest(
      base(),
      overlay({ web: { plugins: { teams: { enabled: false, source: { type: 'git', url: 'https://h/o/r.git' } } } } }),
      'laptop'
    );
    expect(manifest.profiles.web.plugins.teams.enabled).toBe(false);
    expect(manifest.profiles.web.plugins.teams.source).toEqual({ type: 'git', url: 'https://h/o/r.git' });
    expect(manifest.profiles.web.plugins.teams.package).toBe('teams-plugin');
    expect(provenance.web.teams).toEqual({ origin: 'base+overlay:laptop', overridden: ['enabled', 'source'] });
  });

  it('deep merges patch config by id and appends new ids', () => {
    const { manifest, provenance } = mergeManifest(
      base(),
      overlay({
        web: {
          plugins: {
            teams: {
              patches: [
                { id: 'teams', config: { mode: 'solo', limits: { max: 5 } } },
                { id: 'extra', config: { on: true } }
              ]
            }
          }
        }
      }),
      'laptop'
    );
    expect(manifest.profiles.web.plugins.teams.patches).toEqual([
      { id: 'teams', config: { mode: 'solo', limits: { max: 5, min: 1 } } },
      { id: 'extra', config: { on: true } }
    ]);
    expect(provenance.web.teams.overridden).toEqual(['patches.teams', 'patches.extra']);
  });

  it('removes base plugins', () => {
    const { manifest, provenance } = mergeManifest(base(), overlay({ web: { plugins: { heavy: { remove: true } } } }), 'laptop');
    expect(manifest.profiles.web.plugins.heavy).toBeUndefined();
    expect(provenance.web.heavy).toBeUndefined();
  });

  it('deep merges the environment section', () => {
    const { manifest } = mergeManifest(base(), overlay(undefined, { harness: { sourceDir: '/srv/harness' } }), 'server');
    expect(manifest.environment).toEqual({ harness: { sourceDir: '/srv/harness', allowUntestedVersion: false } });
  });

  it('does not mutate the base manifest', () => {
    const original = base();
    mergeManifest(original, overlay({ web: { plugins: { teams: { enabled: false }, heavy: { remove: true } } } }), 'laptop');
    expect(original).toEqual(base());
  });

  it.each([
    ['removing a plugin missing from the base', { web: { plugins: { ghost: { remove: true as const } } } }, /cannot remove a plugin that is not in the base manifest/],
    ['adding a plugin without source', { web: { plugins: { extra: { package: 'extra-plugin' } } } }, /must declare package and source/],
    ['changing package', { web: { plugins: { teams: { package: 'other-plugin' } } } }, /cannot change package/],
    ['adding a patch id without config', { web: { plugins: { teams: { patches: [{ id: 'new' }] } } } }, /patch 'new' is not in the base manifest and must declare config/],
    ['duplicating a package', { web: { plugins: { copy: { package: 'teams-plugin', source: { type: 'npm' as const, version: '1.0.0' } } } } }, /Invalid manifest after applying overlay 'laptop'.*Duplicate package/]
  ])('rejects %s', (_label, profiles, message) => {
    expect(() => mergeManifest(base(), overlay(profiles), 'laptop')).toThrow(message);
  });
});
