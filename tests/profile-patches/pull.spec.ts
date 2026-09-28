import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as YAML from 'yaml';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { pullProfilePatches } from '../../src/profile-patches/pull.js';
import { applyEnvironment } from '../../src/apply/apply.js';
import { loadManifest, parseOverlay } from '../../src/manifest/files.js';
import { readSelectionFile } from '../../src/overlay/selection.js';
import { readProfilePatchState } from '../../src/profile-patches/entries.js';
import { rollbackEnvironment } from '../../src/rollback/rollback.js';
import { writeRemoteOwnedFixture } from '../helpers/remote-fixture.js';

const HEADER = '# Your patch layer for this dsh profile\n';
const LOCALE = { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'zh' } };
const SKILLS = { id: 'skill-filesystem', config: { customSkillDirs: ['/home/me/skills'] } };

describe('pullProfilePatches', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  const patchFile = () => path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
  const base = () => loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
  const overlay = (name = 'local') => {
    const file = path.join(paths.overlaysDir, `${name}.yaml`);
    return parseOverlay(fs.readFileSync(file, 'utf8'), file);
  };
  const live = () => readProfilePatchState(fs.readFileSync(patchFile(), 'utf8'), 'web');
  const pull = (options: Partial<Parameters<typeof pullProfilePatches>[1]> = {}) =>
    pullProfilePatches(paths, { selection: null, allowOverlayCreation: true, ...options });
  const planOperations = async () => (await applyEnvironment(paths, { dryRun: true, overlay: readSelectionFile(paths) ? { name: readSelectionFile(paths)!, via: 'file' } : null })).plan;

  const setupProfile = (home: string) => {
    const profileDir = path.join(home, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), `${HEADER}${YAML.stringify([LOCALE, SKILLS])}`);
  };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-pull-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.managerDir, { recursive: true });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    setupProfile(tempHome);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('takes entries written in DSH into the manifest, machine-local paths into a local overlay, and leaves a clean plan', async () => {
    const result = await pull();
    expect(result.changes).toMatchObject([{ profile: 'web', added: ['locale', 'skill-filesystem'], base: 1, overlay: 1, overlayName: 'local' }]);
    expect(result.overlayCreated).toBe('local');

    expect(base().profiles.web).toEqual({ plugins: {}, patches: [LOCALE] });
    expect(overlay().profiles?.web?.patches).toEqual([SKILLS]);
    expect(readSelectionFile(paths)).toBe('local');

    const state = live();
    expect(state.unmanaged).toEqual([]);
    expect(state.block).toMatchObject({ entries: [LOCALE, SKILLS], isDigestValid: true });
    expect(fs.readFileSync(patchFile(), 'utf8').startsWith(HEADER)).toBe(true);
    expect((await planOperations()).operations).toEqual([]);
    expect((await pull()).changes).toEqual([]);
  });

  it('takes an edit DSH made inside the block', async () => {
    await pull();
    fs.writeFileSync(patchFile(), fs.readFileSync(patchFile(), 'utf8').replace('preference: zh', 'preference: en'));

    const result = await pull({ selection: { name: 'local', via: 'file' } });
    expect(result.changes).toMatchObject([{ profile: 'web', changed: ['locale'], added: [], removed: [] }]);
    expect(base().profiles.web.patches).toEqual([{ ...LOCALE, config: { preference: 'en' } }]);
    expect(live().block?.isDigestValid).toBe(true);
  });

  it('writes nothing on a dry run', async () => {
    const before = fs.readFileSync(patchFile(), 'utf8');
    const result = await pull({ dryRun: true });
    expect(result.changes).toHaveLength(1);
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(before);
    expect(base().profiles).toEqual({});
    expect(fs.existsSync(path.join(paths.overlaysDir, 'local.yaml'))).toBe(false);
    expect(readSelectionFile(paths)).toBeNull();
  });

  it('refuses when both DSH and the manifest changed, until a side is preferred', async () => {
    await pull();
    const manifest = base();
    manifest.profiles.web.patches = [{ ...LOCALE, config: { preference: 'fr' } }];
    fs.writeFileSync(paths.manifestFile, YAML.stringify(manifest));
    fs.writeFileSync(patchFile(), `${fs.readFileSync(patchFile(), 'utf8')}- id: extra\n  config: {}\n`);
    const selection = { name: 'local', via: 'file' as const };

    await expect(pull({ selection })).rejects.toThrow(/changed both in DSH and in the manifest.*--prefer dsh.*--prefer manifest/);

    await pull({ selection, prefer: 'manifest' });
    expect(base().profiles.web.patches).toEqual([{ ...LOCALE, config: { preference: 'fr' } }]);
    expect(live()).toMatchObject({ unmanaged: [], block: { isDigestValid: true, entries: [{ ...LOCALE, config: { preference: 'fr' } }, SKILLS] } });
  });

  it('keeps DSH when DSH is preferred in a conflict', async () => {
    await pull();
    const manifest = base();
    manifest.profiles.web.patches = [];
    fs.writeFileSync(paths.manifestFile, YAML.stringify(manifest));
    fs.writeFileSync(patchFile(), `${fs.readFileSync(patchFile(), 'utf8')}- id: extra\n  config: {}\n`);

    await pull({ selection: { name: 'local', via: 'file' }, prefer: 'dsh' });
    expect(base().profiles.web.patches).toEqual([LOCALE, { id: 'extra', config: {} }]);
  });

  it('refuses machine-local entries under --no-overlay', async () => {
    await expect(pull({ allowOverlayCreation: false })).rejects.toThrow(/machine-local paths.*overlay/);
    expect(base().profiles).toEqual({});
  });

  it('puts everything into a local overlay when a team remote owns the base', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-pull-remote-'));
    try {
      paths = await writeRemoteOwnedFixture(home);
      setupProfile(home);
      tempHome = home;
      const manifestBefore = fs.readFileSync(paths.manifestFile, 'utf8');
      const selection = { name: 'mine', via: 'file' as const };

      const result = await pull({ selection });
      expect(result.changes).toMatchObject([{ base: 0, overlay: 2, overlayName: 'mine' }]);
      expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(manifestBefore);
      expect(overlay('mine').profiles?.web?.patches).toEqual([LOCALE, SKILLS]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('is undone by rollback, which also drops the selection of the overlay it created', async () => {
    const result = await pull();
    await rollbackEnvironment(paths, { operationId: result.operationId });
    expect(base().profiles).toEqual({});
    expect(fs.existsSync(path.join(paths.overlaysDir, 'local.yaml'))).toBe(false);
    expect(readSelectionFile(paths)).toBeNull();
  });
});
