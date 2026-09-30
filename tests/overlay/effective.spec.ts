import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { loadEffectiveManifest, overlaySwitchWarning } from '../../src/overlay/effective.js';
import type { EnvironmentState } from '../../src/domain.js';

const BASE = `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      shared:
        package: shared-plugin
        source: { type: npm, version: "1.0.0" }
`;

describe('loadEffectiveManifest', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-overlay-effective-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, BASE);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns the base manifest when no overlay is selected', () => {
    const effective = loadEffectiveManifest(paths, null);
    expect(effective.overlay).toBeNull();
    expect(effective.provenance.web.shared.origin).toBe('base');
  });

  it('merges the selected overlay', () => {
    fs.writeFileSync(
      path.join(paths.overlaysDir, 'laptop.yaml'),
      'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      shared:\n        enabled: false\n'
    );
    const effective = loadEffectiveManifest(paths, { name: 'laptop', via: 'file' });
    expect(effective.manifest.profiles.web.plugins.shared.enabled).toBe(false);
    expect(effective.overlay).toEqual({ name: 'laptop', via: 'file' });
  });

  it('fails instead of falling back to the base when the overlay is missing', () => {
    expect(() => loadEffectiveManifest(paths, { name: 'ghost', via: 'file' })).toThrow(/Overlay 'ghost' not found/);
  });

  it('reports schema errors with the overlay file path', () => {
    fs.writeFileSync(path.join(paths.overlaysDir, 'bad.yaml'), 'apiVersion: dshenv-overlay/v1\nbogus: 1\n');
    expect(() => loadEffectiveManifest(paths, { name: 'bad', via: 'flag' })).toThrow(/Invalid overlay schema in .*bad\.yaml/);
  });

  it('requires the base manifest', () => {
    fs.rmSync(paths.manifestFile);
    expect(() => loadEffectiveManifest(paths, null)).toThrow(/Manifest file not found/);
  });
});

describe('overlaySwitchWarning', () => {
  const state = (appliedOverlay?: string): EnvironmentState => ({
    apiVersion: 'dshenv-state/v2',
    lastApplied: 'x',
    appliedLockHash: '',
    profiles: {},
    ...(appliedOverlay ? { appliedOverlay } : {})
  });

  it('stays quiet before the first apply and when nothing changed', () => {
    expect(overlaySwitchWarning(null, { name: 'laptop', via: 'file' })).toBeNull();
    expect(overlaySwitchWarning(state('laptop'), { name: 'laptop', via: 'flag' })).toBeNull();
    expect(overlaySwitchWarning(state(), null)).toBeNull();
  });

  it('names the previous and current overlay', () => {
    expect(overlaySwitchWarning(state(), { name: 'laptop', via: 'file' })).toBe('overlay changed since last apply: none → laptop');
    expect(overlaySwitchWarning(state('server'), null)).toBe('overlay changed since last apply: server → none');
  });
});
