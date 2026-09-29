import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment, type ApplyOptions } from '../../src/apply/apply.js';
import { rollbackEnvironment } from '../../src/rollback/rollback.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';

// Fake DSH: `add` installs a bundle package; FAIL_ON makes adds of matching packages fail.
const FAKE_DSH = `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.1.7-rc.2'); process.exit(0); }
if (process.env.FAIL_ON && args.at(-1).includes(process.env.FAIL_ON)) { console.error('dsh: boom'); process.exit(7); }
const profileDir = path.join(process.env.DSH_HOME, 'profiles', args[args.indexOf('--profile') + 1]);
const pkgPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const spec = args.at(-1);
const name = spec.split('@')[0];
const dir = path.join(profileDir, 'node_modules', name);
pkg.dependencies[name] = spec.slice(name.length + 1);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: spec.slice(name.length + 1), dsh: { bundle: {} } }));
if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
fs.writeFileSync(pkgPath, JSON.stringify(pkg));
`;

describe('applyEnvironment failure recovery', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  let previousDshCli: string | undefined;
  const options: ApplyOptions = { probeHmr: async () => ({ state: 'off' }), hmrSettleMs: 0 };

  const plugin = (alias: string) => `      ${alias}:\n        package: "${alias}"\n        source: { type: npm, version: "1.0.0" }\n`;
  const manifest = (...plugins: string[]) => `apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n${plugins.join('')}`;
  const overlay = (...plugins: string[]) => `apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n${plugins.join('')}`;
  const overlayFile = () => path.join(paths.overlaysDir, 'laptop.yaml');

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-recovery-'));
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.overlaysDir, { recursive: true });
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name: 'p', dependencies: {}, dsh: { profile: { bundles: [] } } }));
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, FAKE_DSH);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  });

  afterEach(() => {
    delete process.env.FAIL_ON;
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('names the failed step, its operation and how to get back to the manifest last applied', async () => {
    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa')));
    const good = await applyEnvironment(paths, options);

    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa'), plugin('bb'), plugin('cc')));
    process.env.FAIL_ON = 'cc';
    const failure = await applyEnvironment(paths, options).catch((err: Error) => err);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(/^Apply execution failed at \[web\] install cc \(cc\), step 2 of 2: DSH plugin command exited with code 7/);
    expect(message).toMatch(/\nApply apply-[0-9a-f]{12} put lock\.json and state\.json back; plugins it installed before failing stay installed: bb\.\n/);
    expect(message).toContain(
      `The manifest still declares what failed: fix it and apply again, or go back to the manifest apply ${good.operationId} applied with: dshenv rollback ${good.operationId} --yes`
    );
  });

  it('rolls back past a failed apply that already undid itself, to the last apply that changed something', async () => {
    const goodManifest = manifest(plugin('aa'));
    fs.writeFileSync(paths.manifestFile, goodManifest);
    const good = await applyEnvironment(paths, options);

    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa'), plugin('bb')));
    process.env.FAIL_ON = 'bb';
    await expect(applyEnvironment(paths, options)).rejects.toThrow(/install bb/);

    const result = await rollbackEnvironment(paths);
    expect(result.snapshotId.endsWith(good.operationId!)).toBe(true);
    expect(result.message).toMatch(/^Restored the envctl files as they were before apply-[0-9a-f]{12} \(snapshot /);
    expect(result.message).toMatch(/skipped apply-[0-9a-f]{12}, which failed and had already undone its own changes/);
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(goodManifest);
  });

  it('saves the active overlay in the snapshot and restores it on rollback', async () => {
    fs.writeFileSync(paths.manifestFile, manifest(plugin('aa')));
    const goodOverlay = overlay(plugin('bb'));
    fs.writeFileSync(overlayFile(), goodOverlay);
    const withOverlay: ApplyOptions = { ...options, overlay: { name: 'laptop', via: 'flag' } };
    await applyEnvironment(paths, withOverlay);

    fs.writeFileSync(overlayFile(), overlay(plugin('bb'), plugin('cc')));
    process.env.FAIL_ON = 'cc';
    await expect(applyEnvironment(paths, withOverlay)).rejects.toThrow(/install cc/);

    await rollbackEnvironment(paths);
    expect(fs.readFileSync(overlayFile(), 'utf8')).toBe(goodOverlay);
  });
});
