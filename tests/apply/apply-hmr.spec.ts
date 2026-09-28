import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { loadState } from '../../src/manifest/files.js';
import type { HmrStatus } from '../../src/dsh/hmr.js';
import { readMounts, writeMount } from '../../src/patch/mount.js';

const PKG = '@nanmicoder/dsh-agent-teams';

describe('applyEnvironment hot reload awareness', () => {
  let tempHome: string;
  let paths: EnvironmentPaths;
  let previousDshCli: string | undefined;

  const manifest = (body: string): void => {
    fs.writeFileSync(path.join(tempHome, 'envctl', 'manifest.yaml'), `apiVersion: dshenv/v1\nprofiles:\n  web:\n${body}`);
  };
  const declared = (enabled: boolean, version = '0.1.21'): string =>
    `    plugins:\n      agent-teams:\n        package: "${PKG}"\n        enabled: ${enabled}\n        source:\n          type: npm\n          version: "${version}"\n`;

  const profileDir = (): string => path.join(tempHome, 'profiles', 'web');
  const profileJson = (): string => path.join(profileDir(), 'package.json');
  const install = (version: string, bundles: string[]): void => {
    const packageDir = path.join(profileDir(), 'node_modules', '@nanmicoder', 'dsh-agent-teams');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      profileJson(),
      JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: { [PKG]: version }, dsh: { profile: { bundles } } })
    );
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: PKG, version, dsh: { bundle: {} } }));
  };
  const stateEntry = () => loadState(fs.readFileSync(paths.stateFile, 'utf8')).profiles.web?.plugins[PKG];
  // Only plugins dshenv owns are uninstalled when the manifest drops them.
  const own = (): void => {
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
    state.ownership = {
      web: {
        [PKG]: { package: PKG, alias: 'agent-teams', sourceType: 'npm', lockedVersion: '0.1.21', adoptedAt: '2026-01-01T00:00:00.000Z', adoptedBy: 'test' }
      }
    };
    fs.writeFileSync(paths.stateFile, JSON.stringify(state));
  };
  const probeReturning = (status: HmrStatus) => vi.fn(async (_profile: string) => status);

  // Logs each `plugin` call with the bundle list and package.json mtime it saw; add/remove behave like DSH.
  const configureFakeDsh = (): string => {
    const log = path.join(tempHome, 'dsh-calls.jsonl');
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.1.7-rc.2'); process.exit(0); }
if (args.includes('--dump-config')) process.exit(1);
const profile = args[args.indexOf('--profile') + 1];
const profileDir = path.join(process.env.DSH_HOME, 'profiles', profile);
const pkgJsonPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args, at: Date.now(), bundles: pkg.dsh.profile.bundles, packageJsonMtimeMs: fs.statSync(pkgJsonPath).mtimeMs
}) + '\\n');
const spec = args.at(-1);
if (args.includes('remove')) {
  delete pkg.dependencies[spec];
  fs.rmSync(path.join(profileDir, 'node_modules', ...spec.split('/')), { recursive: true, force: true });
} else {
  const name = spec.slice(0, spec.indexOf('@', 1));
  const version = spec.slice(name.length + 1);
  pkg.dependencies[name] = version;
  const dir = path.join(profileDir, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version, dsh: { bundle: {} } }));
}
fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg));
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
    return log;
  };
  const dshCalls = (log: string): Array<{ args: string[]; at: number; bundles: string[]; packageJsonMtimeMs: number }> =>
    fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-hmr-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'state.json'),
      JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: '2026-01-01T00:00:00.000Z', appliedLockHash: '', profiles: {} })
    );
    paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('marks a hot-reloaded enable healthy and reports it as needing no restart', async () => {
    install('0.1.21', []);
    manifest(declared(true));
    const probeHmr = probeReturning({ state: 'on' });

    const result = await applyEnvironment(paths, { probeHmr });

    expect(probeHmr).toHaveBeenCalledTimes(1);
    expect(probeHmr).toHaveBeenCalledWith('web');
    expect(result.restart).toEqual({
      notRequired: [{ profile: 'web', package: PKG, kind: 'enable', reason: 'hmr-on' }],
      required: []
    });
    expect(stateEntry()).toMatchObject({ package: PKG, status: 'healthy', installedVersion: '0.1.21' });
  });

  it('keeps restart-required when hot reload is off', async () => {
    install('0.1.21', [PKG]);
    manifest(declared(false));

    const result = await applyEnvironment(paths, { probeHmr: probeReturning({ state: 'off' }) });

    expect(result.restart).toEqual({
      notRequired: [],
      required: [{ profile: 'web', package: PKG, kind: 'disable', reason: 'hmr-off' }]
    });
    expect(stateEntry()?.status).toBe('restart-required');
  });

  it('keeps restart-required with the probe detail when hot reload is unknown', async () => {
    install('0.1.21', [PKG]);
    manifest(declared(false));

    const result = await applyEnvironment(paths, { probeHmr: probeReturning({ state: 'unknown', reason: 'boom' }) });

    expect(result.restart?.required).toEqual([
      { profile: 'web', package: PKG, kind: 'disable', reason: 'hmr-unknown', detail: 'boom' }
    ]);
    expect(stateEntry()?.status).toBe('restart-required');
  });

  it('always requires a restart for a package update', async () => {
    install('0.1.20', [PKG]);
    manifest(declared(true, '0.1.21'));
    configureFakeDsh();

    const result = await applyEnvironment(paths, { probeHmr: probeReturning({ state: 'on' }) });

    expect(result.restart?.required).toEqual([{ profile: 'web', package: PKG, kind: 'update', reason: 'package-update' }]);
    expect(stateEntry()).toMatchObject({ status: 'restart-required', installedVersion: '0.1.21' });
  });

  it('does not clear a restart an earlier apply still owes', async () => {
    install('0.1.21', [PKG]);
    manifest(declared(false));
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
    state.profiles = { web: { plugins: { [PKG]: { package: PKG, status: 'restart-required', installedVersion: '0.1.21' } } } };
    fs.writeFileSync(paths.stateFile, JSON.stringify(state));

    const result = await applyEnvironment(paths, { probeHmr: probeReturning({ state: 'on' }) });

    expect(result.restart?.notRequired).toHaveLength(1);
    expect(stateEntry()?.status).toBe('restart-required');
  });

  it('removes the bundle, waits for hot reload to settle, then uninstalls, and drops the state entry', async () => {
    install('0.1.21', [PKG]);
    manifest('    plugins: {}\n');
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
    state.profiles = { web: { plugins: { [PKG]: { package: PKG, status: 'healthy', installedVersion: '0.1.21' } } } };
    fs.writeFileSync(paths.stateFile, JSON.stringify(state));
    own();
    const log = configureFakeDsh();

    const result = await applyEnvironment(paths, { probeHmr: probeReturning({ state: 'on' }), hmrSettleMs: 400 });

    expect(result.restart?.notRequired).toEqual([{ profile: 'web', package: PKG, kind: 'remove', reason: 'hmr-on' }]);
    const [removeCall] = dshCalls(log);
    expect(removeCall.args).toEqual(['plugin', '--profile', 'web', 'remove', PKG]);
    expect(removeCall.bundles).not.toContain(PKG);
    expect(removeCall.at - removeCall.packageJsonMtimeMs).toBeGreaterThanOrEqual(350);
    expect(stateEntry()).toBeUndefined();
  });

  it('waits for hot reload to unload a mounted plugin that is not a DSH bundle before uninstalling it', async () => {
    install('0.1.21', []);
    fs.writeFileSync(path.join(profileDir(), 'node_modules', '@nanmicoder', 'dsh-agent-teams', 'package.json'), JSON.stringify({ name: PKG, version: '0.1.21' }));
    const patchFile = path.join(profileDir(), 'cordis.patch.yml');
    fs.writeFileSync(patchFile, writeMount('[]\n', 'web', 'agent-teams', PKG));
    manifest('    plugins: {}\n');
    own();
    const log = configureFakeDsh();

    await applyEnvironment(paths, { probeHmr: probeReturning({ state: 'on' }), hmrSettleMs: 400 });

    const [removeCall] = dshCalls(log);
    expect(removeCall.args).toEqual(['plugin', '--profile', 'web', 'remove', PKG]);
    expect(readMounts(fs.readFileSync(patchFile, 'utf8'), 'web')).toEqual({});
    expect(removeCall.at - fs.statSync(patchFile).mtimeMs).toBeGreaterThanOrEqual(350);
  });

  it('restores the bundle and leaves state untouched when dsh plugin remove fails with hot reload on', async () => {
    install('0.1.21', [PKG]);
    manifest('    plugins: {}\n');
    const state = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
    state.profiles = { web: { plugins: { [PKG]: { package: PKG, status: 'healthy', installedVersion: '0.1.21' } } } };
    fs.writeFileSync(paths.stateFile, JSON.stringify(state));
    own();
    const stateBefore = fs.readFileSync(paths.stateFile, 'utf8');
    const fakeDsh = path.join(tempHome, 'failing-remove-dsh.mjs');
    fs.writeFileSync(fakeDsh, `if (process.argv.includes('--version')) { console.log('0.1.7-rc.2'); process.exit(0); }\nprocess.exit(1);\n`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    await expect(
      applyEnvironment(paths, { probeHmr: probeReturning({ state: 'on' }), hmrSettleMs: 50 })
    ).rejects.toThrow(/exited with code 1/);

    expect(JSON.parse(fs.readFileSync(profileJson(), 'utf8')).dsh.profile.bundles).toEqual([PKG]);
    expect(fs.readFileSync(paths.stateFile, 'utf8')).toBe(stateBefore);
  });

  it('does not wait when removing an in-box plugin with hot reload on', async () => {
    fs.mkdirSync(profileDir(), { recursive: true });
    fs.writeFileSync(profileJson(), JSON.stringify({ name: 'dsh-profile-web', private: true, dsh: { profile: { bundles: [PKG] } } }));
    manifest('    plugins: {}\n');
    own();

    const started = Date.now();
    const result = await applyEnvironment(paths, { probeHmr: probeReturning({ state: 'on' }), hmrSettleMs: 5000 });

    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.restart?.notRequired).toEqual([{ profile: 'web', package: PKG, kind: 'remove', reason: 'hmr-on' }]);
    expect(JSON.parse(fs.readFileSync(profileJson(), 'utf8')).dsh.profile.bundles).toEqual([]);
  });

  it('does not wait before uninstalling a plugin that was not in the bundle list, since DSH never loaded it', async () => {
    install('0.1.21', []);
    manifest('    plugins: {}\n');
    own();
    configureFakeDsh();

    const started = Date.now();
    const result = await applyEnvironment(paths, { probeHmr: probeReturning({ state: 'on' }), hmrSettleMs: 3000 });

    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.restart?.notRequired).toEqual([{ profile: 'web', package: PKG, kind: 'remove', reason: 'hmr-on' }]);
  });

  it('does not wait before uninstalling when hot reload is off', async () => {
    install('0.1.21', [PKG]);
    manifest('    plugins: {}\n');
    own();
    configureFakeDsh();

    const started = Date.now();
    const result = await applyEnvironment(paths, { probeHmr: probeReturning({ state: 'off' }), hmrSettleMs: 5000 });

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.restart?.required).toEqual([{ profile: 'web', package: PKG, kind: 'remove', reason: 'hmr-off' }]);
    expect(stateEntry()?.status).toBe('restart-required');
  });

  it('probes during a dry run and reports the restart summary without writing anything', async () => {
    install('0.1.21', []);
    manifest(declared(true));
    const before = { state: fs.readFileSync(paths.stateFile, 'utf8'), profile: fs.readFileSync(profileJson(), 'utf8') };
    const probeHmr = probeReturning({ state: 'on' });

    const result = await applyEnvironment(paths, { dryRun: true, probeHmr });

    expect(probeHmr).toHaveBeenCalledTimes(1);
    expect(result.restart?.notRequired).toEqual([{ profile: 'web', package: PKG, kind: 'enable', reason: 'hmr-on' }]);
    expect(fs.readFileSync(paths.stateFile, 'utf8')).toBe(before.state);
    expect(fs.readFileSync(profileJson(), 'utf8')).toBe(before.profile);
  });

  it('does not probe or report restarts when the environment is in sync', async () => {
    install('0.1.21', [PKG]);
    manifest(declared(true));
    const probeHmr = probeReturning({ state: 'on' });

    const result = await applyEnvironment(paths, { probeHmr });

    expect(result.applied).toBe(false);
    expect(probeHmr).not.toHaveBeenCalled();
    expect(result.restart).toBeUndefined();
  });

  it('falls back to restart-required when the default probe cannot run dsh', async () => {
    install('0.1.21', []);
    manifest(declared(true));
    process.env.DSH_CLI = path.join(tempHome, 'missing-dsh');

    const result = await applyEnvironment(paths);

    expect(result.restart?.required).toMatchObject([{ kind: 'enable', reason: 'hmr-unknown' }]);
    expect(stateEntry()?.status).toBe('restart-required');
  });

  it('keeps DSH_CLI arguments out of the restart detail', async () => {
    install('0.1.21', []);
    manifest(declared(true));
    const fakeDsh = path.join(tempHome, 'failing-dsh.mjs');
    fs.writeFileSync(fakeDsh, `process.exit(2);`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh, '--Authorization', "'Bearer SECRET'"]);

    const result = await applyEnvironment(paths, { dryRun: true });

    expect(result.restart?.required).toEqual([
      { profile: 'web', package: PKG, kind: 'enable', reason: 'hmr-unknown', detail: 'dsh --dump-config exited with code 2' }
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('reads the hmr row through the default probe', async () => {
    install('0.1.21', []);
    manifest(declared(true));
    const argsFile = path.join(tempHome, 'dump-args.json');
    const fakeDsh = path.join(tempHome, 'dump-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: process.argv.slice(2), home: process.env.DSH_HOME }));
process.stdout.write("- id: hmr\\n  name: '@deepseek-ai/dsh-hmr'\\n  disabled: !!js '!ctx.get(''profileContext'')'\\n");
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    const result = await applyEnvironment(paths, { dryRun: true });

    expect(result.restart?.notRequired).toMatchObject([{ kind: 'enable', reason: 'hmr-on' }]);
    expect(JSON.parse(fs.readFileSync(argsFile, 'utf8'))).toEqual({ args: ['--profile', 'web', '--dump-config'], home: tempHome });
  });

  it('does not run dsh --dump-config for a profile that does not exist yet', async () => {
    manifest(declared(true));
    const marker = path.join(tempHome, 'dsh-was-called');
    const fakeDsh = path.join(tempHome, 'must-not-run.mjs');
    fs.writeFileSync(fakeDsh, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'called');`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    const result = await applyEnvironment(paths, { dryRun: true });

    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(profileDir())).toBe(false);
    expect(result.restart?.required).toEqual([
      { profile: 'web', package: PKG, kind: 'install', reason: 'hmr-unknown', detail: 'profile web does not exist yet' }
    ]);
  });

  it('refuses a blocked plan before probing hot reload', async () => {
    install('0.1.21', []);
    manifest(`${declared(true)}      pinned:\n        package: "git-plugin"\n        source:\n          type: git\n          url: "https://example.com/p.git"\n`);
    const probeHmr = probeReturning({ state: 'on' });

    await expect(applyEnvironment(paths, { probeHmr })).rejects.toThrow('Apply is blocked');
    expect(probeHmr).not.toHaveBeenCalled();
  });

  it('probes the profiles of one apply concurrently', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1\nprofiles:\n  web:\n${declared(true)}  cli:\n${declared(true)}`
    );
    let active = 0;
    let peak = 0;
    const probeHmr = vi.fn(async (_profile: string): Promise<HmrStatus> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 50));
      active -= 1;
      return { state: 'off' };
    });

    const result = await applyEnvironment(paths, { probeHmr, dryRun: true });

    expect(probeHmr).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
    expect(result.restart?.required.map((item) => item.profile).sort()).toEqual(['cli', 'web']);
  });
});
