import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { clearManagedPatches, snapshotProfilePatchFile, writeManagedPatches } from '../../src/apply/patches.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { extractManagedPatches } from '../../src/patch/patch.js';

describe('cordis.patch.yml profile lock', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  let profileDir: string;
  const patchFile = (): string => path.join(profileDir, 'cordis.patch.yml');
  const lockFile = (): string => path.join(profileDir, 'package.json.lock');
  const dshPatch = '- id: dsh-owned\n  name: other\n';
  // Simulates DSH finishing its own patch write, then releasing the lock.
  const dshReleasesAfter = (ms: number, content: string): void => {
    fs.writeFileSync(lockFile(), '999999\n', { mode: 0o600 });
    setTimeout(() => {
      fs.writeFileSync(patchFile(), content);
      fs.rmSync(lockFile(), { force: true });
    }, ms);
  };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-patches-lock-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), '{}');
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('waits for a lock held by DSH before reading and writing managed patches', async () => {
    dshReleasesAfter(300, dshPatch);
    const started = Date.now();
    await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    const content = fs.readFileSync(patchFile(), 'utf8');
    expect(content).toContain('dsh-owned');
    expect(extractManagedPatches(content, 'web').map((patch) => patch.id)).toEqual(['p1']);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('waits for a lock held by DSH before clearing managed patches', async () => {
    await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    const withDsh = `${fs.readFileSync(patchFile(), 'utf8')}${dshPatch}`;
    dshReleasesAfter(300, withDsh);
    await clearManagedPatches(paths, 'web', 'demo');
    const content = fs.readFileSync(patchFile(), 'utf8');
    expect(content).toContain('dsh-owned');
    expect(extractManagedPatches(content, 'web')).toEqual([]);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('waits for a lock held by DSH before restoring a patch snapshot', async () => {
    fs.writeFileSync(patchFile(), 'original\n');
    const restore = await snapshotProfilePatchFile(paths, 'web');
    fs.writeFileSync(lockFile(), '999999\n', { mode: 0o600 });
    setTimeout(() => fs.rmSync(lockFile(), { force: true }), 300);
    const started = Date.now();
    await restore();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe('original\n');
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('writes patches for a profile whose directory does not exist yet without locking', async () => {
    fs.rmSync(profileDir, { recursive: true, force: true });
    await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    expect(extractManagedPatches(fs.readFileSync(patchFile(), 'utf8'), 'web').map((patch) => patch.id)).toEqual(['p1']);
    expect(fs.existsSync(lockFile())).toBe(false);
  });
});
