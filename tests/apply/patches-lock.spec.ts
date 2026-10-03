import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { clearManagedPatches, writeManagedPatches } from '../../src/apply/patches.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import * as YAML from 'yaml';
import { extractManagedPatches, renderPatchBlock } from '../../src/patch/patch.js';

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
    fs.writeFileSync(patchFile(), dshPatch);
    const restore = await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    fs.writeFileSync(lockFile(), '999999\n', { mode: 0o600 });
    setTimeout(() => fs.rmSync(lockFile(), { force: true }), 300);
    const started = Date.now();
    await restore();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(dshPatch);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('restores the snapshot byte for byte when nothing else touched the file after dshenv wrote it', async () => {
    await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    fs.appendFileSync(patchFile(), `# kept comment\n${dshPatch}`);
    const before = fs.readFileSync(patchFile(), 'utf8');
    const restore = await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 2 } }]);
    await restore();
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(before);
  });

  it('keeps an edit DSH made after dshenv wrote the file and only puts the plugin blocks back', async () => {
    await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    await writeManagedPatches(paths, 'web', 'other', [{ id: 'o1', config: { b: 1 } }]);
    const before = fs.readFileSync(patchFile(), 'utf8');
    const demoBlock = before.slice(before.indexOf('# dshenv:begin profile=web plugin=demo'), before.indexOf('# dshenv:begin profile=web plugin=other'));
    const restore = await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 2 } }, { id: 'p2', config: { c: 3 } }]);
    fs.appendFileSync(patchFile(), dshPatch);

    await restore();

    const content = fs.readFileSync(patchFile(), 'utf8');
    expect(content).toContain(dshPatch);
    expect(content).toContain(demoBlock);
    expect(extractManagedPatches(content, 'web').map((patch) => [patch.plugin, patch.id, patch.config])).toEqual([
      ['demo', 'p1', { a: 1 }],
      ['other', 'o1', { b: 1 }]
    ]);
  });

  it('keeps a DSH edit made between two dshenv writes when both are undone in reverse', async () => {
    fs.writeFileSync(patchFile(), '- id: base\n  name: x\n');
    const undoDemo = await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    fs.appendFileSync(patchFile(), dshPatch);
    const undoOther = await writeManagedPatches(paths, 'web', 'other', [{ id: 'o1', config: { b: 1 } }]);

    await undoOther();
    await undoDemo();

    const content = fs.readFileSync(patchFile(), 'utf8');
    expect(content).toContain(dshPatch);
    expect(content).toContain('id: base');
    expect(extractManagedPatches(content, 'web')).toEqual([]);
  });

  it('drops the plugin blocks but keeps a DSH edit when the file did not exist before dshenv wrote it', async () => {
    const restore = await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    fs.appendFileSync(patchFile(), dshPatch);

    await restore();

    const content = fs.readFileSync(patchFile(), 'utf8');
    expect(content).toContain(dshPatch);
    expect(extractManagedPatches(content, 'web')).toEqual([]);
  });

  it('puts removed plugin blocks back without losing a DSH edit made after the clear', async () => {
    await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    const restore = await clearManagedPatches(paths, 'web', 'demo');
    // The clear left `[]`; DSH writes its entry as the new top-level array.
    fs.writeFileSync(patchFile(), dshPatch);

    await restore();

    const content = fs.readFileSync(patchFile(), 'utf8');
    expect(content).toContain(dshPatch);
    expect(extractManagedPatches(content, 'web').map((patch) => patch.id)).toEqual(['p1']);
  });

  it('keeps a DSH edit made while dshenv waited for the lock when the write is undone', async () => {
    dshReleasesAfter(300, dshPatch);
    const restore = await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);

    await restore();

    const content = fs.readFileSync(patchFile(), 'utf8');
    expect(content).toBe(dshPatch);
  });

  it('refuses to write managed patches into a file that is not a top-level array', async () => {
    fs.writeFileSync(patchFile(), 'keep: 1\n');
    await expect(writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }])).rejects.toThrow(/top-level YAML array/);
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe('keep: 1\n');
  });

  it('repairs a file the old append left invalid before writing, and undo puts the original bytes back', async () => {
    const broken = `[{id: existing, config: {}}]\n\n${renderPatchBlock('web', 'other', 'o1', { b: 1 })}\n`;
    fs.writeFileSync(patchFile(), broken);

    const restore = await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    const content = fs.readFileSync(patchFile(), 'utf8');
    expect(YAML.parse(content).map((entry: { id: string }) => entry.id)).toEqual(['existing', 'o1', 'p1']);

    await restore();
    expect(fs.readFileSync(patchFile(), 'utf8')).toBe(broken);
  });

  it('writes patches for a profile whose directory does not exist yet without locking', async () => {
    fs.rmSync(profileDir, { recursive: true, force: true });
    await writeManagedPatches(paths, 'web', 'demo', [{ id: 'p1', config: { a: 1 } }]);
    expect(extractManagedPatches(fs.readFileSync(patchFile(), 'utf8'), 'web').map((patch) => patch.id)).toEqual(['p1']);
    expect(fs.existsSync(lockFile())).toBe(false);
  });
});
