import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { parseOverlay } from '../../src/manifest/files.js';
import {
  removeOverlayPlugin,
  resolveWriteLayer,
  saveOverlay,
  setOverlayPatchValue,
  setOverlayPluginFields
} from '../../src/overlay/write.js';
import type { EnvironmentManifest, EnvironmentOverlay } from '../../src/domain.js';

const base: EnvironmentManifest = {
  apiVersion: 'dshenv/v1',
  profiles: { web: { plugins: { teams: { package: 'teams-plugin', enabled: true, source: { type: 'npm', version: '1.0.0' } } } } }
};
const empty = (): EnvironmentOverlay => ({ apiVersion: 'dshenv-overlay/v1' });

describe('resolveWriteLayer', () => {
  const laptop = { name: 'laptop', via: 'file' as const };

  it('defaults to base without an overlay', () => {
    expect(resolveWriteLayer(null, undefined)).toBe('base');
    expect(resolveWriteLayer(null, 'base')).toBe('base');
  });

  it('requires an explicit layer when an overlay is active', () => {
    expect(() => resolveWriteLayer(laptop, undefined)).toThrow(/Overlay 'laptop' is active; pass --layer base or --layer overlay/);
    expect(resolveWriteLayer(laptop, 'overlay')).toBe('overlay');
    expect(resolveWriteLayer(laptop, 'base')).toBe('base');
  });

  it('rejects overlay writes without an overlay and unknown layers', () => {
    expect(() => resolveWriteLayer(null, 'overlay')).toThrow(/--layer overlay requires an active overlay/);
    expect(() => resolveWriteLayer(laptop, 'both')).toThrow(/Invalid --layer/);
  });
});

describe('overlay edits', () => {
  it('writes only the given fields and replaces a tombstone', () => {
    const doc = empty();
    setOverlayPluginFields(doc, 'web', 'teams', { enabled: false });
    expect(doc.profiles?.web.plugins?.teams).toEqual({ enabled: false });
    removeOverlayPlugin(doc, base, 'web', 'teams');
    setOverlayPluginFields(doc, 'web', 'teams', { enabled: true });
    expect(doc.profiles?.web.plugins?.teams).toEqual({ enabled: true });
  });

  it('sets a single patch key', () => {
    const doc = empty();
    setOverlayPatchValue(doc, 'web', 'teams', 'teams', 'limits.max', 5);
    setOverlayPatchValue(doc, 'web', 'teams', 'teams', 'mode', 'solo');
    expect(doc.profiles?.web.plugins?.teams.patches).toEqual([{ id: 'teams', config: { limits: { max: 5 }, mode: 'solo' } }]);
  });

  it('tombstones base plugins and deletes overlay-only ones', () => {
    const doc = empty();
    expect(removeOverlayPlugin(doc, base, 'web', 'teams')).toBe('tombstoned');
    expect(doc.profiles?.web.plugins?.teams).toEqual({ remove: true });

    setOverlayPluginFields(doc, 'web', 'extra', { package: 'extra-plugin', enabled: true, source: { type: 'npm', version: '1.0.0' } });
    expect(removeOverlayPlugin(doc, base, 'web', 'extra')).toBe('deleted');
    expect(doc.profiles?.web.plugins?.extra).toBeUndefined();

    expect(() => removeOverlayPlugin(doc, base, 'web', 'ghost')).toThrow(/Plugin 'ghost' not found/);
  });
});

describe('saveOverlay', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-overlay-write-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('writes a valid overlay and refuses one that breaks the merge', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const file = path.join(paths.overlaysDir, 'laptop.yaml');
    const doc = empty();
    setOverlayPluginFields(doc, 'web', 'teams', { enabled: false });
    await saveOverlay(paths, 'laptop', base, doc);
    expect(parseOverlay(fs.readFileSync(file, 'utf8'), file)).toEqual(doc);

    const bad = empty();
    setOverlayPluginFields(bad, 'web', 'extra', { package: 'extra-plugin' });
    await expect(saveOverlay(paths, 'laptop', base, bad)).rejects.toThrow(/must declare package and source/);
    expect(parseOverlay(fs.readFileSync(file, 'utf8'), file)).toEqual(doc);
  });
});
