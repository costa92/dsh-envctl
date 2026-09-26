import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execa } from 'execa';
import { runCli } from '../../src/cli.js';
import { loadLock, loadManifest, parseOverlay } from '../../src/manifest/files.js';
import { writeOverlayFixture } from '../helpers/overlay-fixture.js';

describe('CLI writes with an active overlay', () => {
  let tempHome: string;
  const manifestFile = () => path.join(tempHome, 'envctl', 'manifest.yaml');
  const overlayFile = () => path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml');
  const overlay = () => parseOverlay(fs.readFileSync(overlayFile(), 'utf8'), overlayFile());
  const run = async (args: string[]) => {
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], { stdout: () => {}, stderr: (chunk) => { stderr += chunk; } });
    return { code, stderr };
  };
  const runOut = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-overlay-write-'));
    writeOverlayFixture(tempHome);
    await run(['overlay', 'use', 'laptop']);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('refuses writes without --layer and leaves both files unchanged', async () => {
    const before = [fs.readFileSync(manifestFile(), 'utf8'), fs.readFileSync(overlayFile(), 'utf8')];
    const { code, stderr } = await run(['disable', 'shared', '--profile', 'web']);
    expect(code).toBe(3);
    expect(stderr).toMatch(/pass --layer base or --layer overlay/);
    expect([fs.readFileSync(manifestFile(), 'utf8'), fs.readFileSync(overlayFile(), 'utf8')]).toEqual(before);
  });

  it('writes enabled only into the overlay with --layer overlay', async () => {
    const baseBefore = fs.readFileSync(manifestFile(), 'utf8');
    expect((await run(['disable', 'shared', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.shared).toEqual({ enabled: false });
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(baseBefore);
  });

  it('writes the base with --layer base', async () => {
    const overlayBefore = fs.readFileSync(overlayFile(), 'utf8');
    expect((await run(['disable', 'shared', '--profile', 'web', '--layer', 'base'])).code).toBe(0);
    expect(loadManifest(fs.readFileSync(manifestFile(), 'utf8')).profiles.web.plugins.shared.enabled).toBe(false);
    expect(fs.readFileSync(overlayFile(), 'utf8')).toBe(overlayBefore);
  });

  it('enables a plugin in the overlay', async () => {
    expect((await run(['enable', 'extra', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.extra.enabled).toBe(true);
  });

  it('tombstones base plugins and deletes overlay-only plugins on remove', async () => {
    expect((await run(['remove', 'shared', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.shared).toEqual({ remove: true });
    expect((await run(['remove', 'extra', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.extra).toBeUndefined();
  });

  it('sets one config key in the overlay', async () => {
    expect((await run(['config', 'set', 'shared', 'mode', 'solo', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.shared.patches).toEqual([{ id: 'shared', config: { mode: 'solo' } }]);
  });

  it('installs new plugins and overrides existing ones in the overlay', async () => {
    expect((await run(['install', 'new-plugin@3.0.0', '--profile', 'web', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.['new-plugin']).toEqual({
      package: 'new-plugin',
      enabled: true,
      source: { type: 'npm', version: '3.0.0' }
    });

    expect((await run(['install', 'shared-plugin@1.5.0', '--profile', 'web', '--as', 'shared', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.shared).toEqual({ enabled: true, source: { type: 'npm', version: '1.5.0' } });

    const clash = await run(['install', 'other-plugin@1.0.0', '--profile', 'web', '--as', 'shared', '--layer', 'overlay']);
    expect(clash.code).toBe(3);
    expect(clash.stderr).toMatch(/cannot change its package/);
  });

  it('overrides the npm version in the overlay and pins the lock', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'lock.json'),
      JSON.stringify({
        apiVersion: 'dshenv-lock/v1',
        profiles: { web: { plugins: { shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '1.0.0' } } } } }
      })
    );
    expect((await run(['update', 'shared', '--profile', 'web', '--to', '1.1.0', '--layer', 'overlay'])).code).toBe(0);
    expect(overlay().profiles?.web.plugins?.shared).toEqual({ source: { type: 'npm', version: '1.1.0' } });
    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    expect(lock.profiles.web.plugins.shared.source).toMatchObject({ resolvedVersion: '1.1.0' });
  });

  it('source clone --profile --layer overlay writes the overlay, not the base, and reports the layer', async () => {
    const upstream = path.join(tempHome, 'upstream', 'demo-plugin');
    fs.mkdirSync(upstream, { recursive: true });
    await execa('git', ['init'], { cwd: upstream });
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: upstream });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream });
    fs.writeFileSync(path.join(upstream, 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0' }));
    await execa('git', ['add', '.'], { cwd: upstream });
    await execa('git', ['commit', '-m', 'init'], { cwd: upstream });

    const cloneDir = path.join(tempHome, 'envctl', 'sources', 'web', 'demo-plugin');
    const baseBefore = fs.readFileSync(manifestFile(), 'utf8');

    const noLayer = await run(['source', 'clone', upstream, '--profile', 'web', '--as', 'demo']);
    expect(noLayer.code).toBe(3);
    expect(fs.existsSync(cloneDir)).toBe(false);

    const { code, stdout } = await runOut([
      'source', 'clone', upstream, '--profile', 'web', '--as', 'demo', '--layer', 'overlay', '--json'
    ]);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(cloneDir, 'package.json'))).toBe(true);

    const parsed = JSON.parse(stdout) as { layer: string; overlay: string };
    expect(parsed.layer).toBe('overlay');
    expect(parsed.overlay).toBe('laptop');

    expect(overlay().profiles?.web.plugins?.demo).toEqual({
      package: 'demo-plugin',
      enabled: true,
      source: { type: 'git', url: upstream }
    });
    expect(fs.readFileSync(manifestFile(), 'utf8')).toBe(baseBefore);

    const lock = loadLock(fs.readFileSync(path.join(tempHome, 'envctl', 'lock.json'), 'utf8'));
    const gitSource = lock.profiles.web.plugins.demo.source;
    expect(gitSource.type).toBe('git');

    const upstream2 = path.join(tempHome, 'upstream', 'demo-plugin-2');
    fs.mkdirSync(upstream2, { recursive: true });
    await execa('git', ['init'], { cwd: upstream2 });
    await execa('git', ['config', 'user.name', 'Tester'], { cwd: upstream2 });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: upstream2 });
    fs.writeFileSync(path.join(upstream2, 'package.json'), JSON.stringify({ name: 'demo-plugin-2', version: '1.0.0' }));
    await execa('git', ['add', '.'], { cwd: upstream2 });
    await execa('git', ['commit', '-m', 'init'], { cwd: upstream2 });

    const { code: textCode, stdout: textOut, stderr: textErr } = await runOut([
      'source', 'clone', upstream2, '--profile', 'web', '--as', 'demo2', '--layer', 'overlay'
    ]);
    expect(textCode).toBe(0);
    expect(textErr).toBe('');
    expect(textOut).toMatch(/\(overlay 'laptop'\)/);
  });

  it('rejects --layer overlay without an active overlay and adopt into an overlay', async () => {
    await run(['overlay', 'use', '--none']);
    expect((await run(['disable', 'shared', '--profile', 'web', '--layer', 'overlay'])).code).toBe(3);
    await run(['overlay', 'use', 'laptop']);
    const adopt = await run(['adopt', '--from', path.join(tempHome, 'missing.yaml'), '--layer', 'overlay']);
    expect(adopt.code).toBe(3);
    expect(adopt.stderr).toMatch(/adopt only writes the base manifest/);
  });

  it('refuses a base write that the active overlay can no longer merge onto', async () => {
    fs.writeFileSync(overlayFile(), 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      heavy:\n        enabled: false\n');
    const before = [fs.readFileSync(manifestFile(), 'utf8'), fs.readFileSync(overlayFile(), 'utf8')];
    const { code, stderr } = await run(['remove', 'heavy', '--profile', 'web', '--layer', 'base']);
    expect(code).toBe(3);
    expect(stderr).toMatch(/must declare package and source/);
    expect([fs.readFileSync(manifestFile(), 'utf8'), fs.readFileSync(overlayFile(), 'utf8')]).toEqual(before);
  });
});
