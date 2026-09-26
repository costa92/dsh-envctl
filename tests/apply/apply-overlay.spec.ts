import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { loadState } from '../../src/manifest/files.js';

describe('applyEnvironment with an overlay', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-overlay-'));
    const envctl = path.join(tempHome, 'envctl');
    fs.mkdirSync(path.join(envctl, 'overlays'), { recursive: true });
    fs.writeFileSync(
      path.join(envctl, 'manifest.yaml'),
      'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      teams:\n        package: teams-plugin\n        source: { type: npm, version: "1.0.0" }\n'
    );
    fs.writeFileSync(
      path.join(envctl, 'overlays', 'laptop.yaml'),
      'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      teams:\n        enabled: false\n'
    );
    const profileDir = path.join(tempHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'teams-plugin'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'node_modules', 'teams-plugin', 'package.json'), JSON.stringify({ name: 'teams-plugin', version: '1.0.0' }));
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'teams-plugin': '1.0.0' }, dsh: { profile: { bundles: ['teams-plugin'] } } })
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('applies the merged manifest and records the overlay', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths, { overlay: { name: 'laptop', via: 'flag' } });
    expect(result.plan.operations.map((op) => op.kind)).toEqual(['disable']);

    const bundles = JSON.parse(fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), 'utf8')).dsh.profile.bundles;
    expect(bundles).not.toContain('teams-plugin');
    expect(loadState(fs.readFileSync(paths.stateFile, 'utf8')).appliedOverlay).toBe('laptop');
    expect(fs.readFileSync(path.join(paths.logsDir, 'journal.jsonl'), 'utf8')).toContain('"overlay":"laptop"');

    const baseOnly = await applyEnvironment(paths, { dryRun: true });
    expect(baseOnly.plan.operations.map((op) => op.kind)).toEqual(['enable']);
  });

  it('omits appliedOverlay when no overlay is active', async () => {
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      teams:\n        package: teams-plugin\n        enabled: false\n        source: { type: npm, version: "1.0.0" }\n'
    );
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await applyEnvironment(paths);
    expect(loadState(fs.readFileSync(paths.stateFile, 'utf8'))).not.toHaveProperty('appliedOverlay');
  });

  it('installs the overlay version even when the lock holds another one', async () => {
    const envctl = path.join(tempHome, 'envctl');
    fs.writeFileSync(
      path.join(envctl, 'overlays', 'laptop.yaml'),
      'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      extra:\n        package: extra-plugin\n        source: { type: npm, version: "2.0.0" }\n'
    );
    fs.writeFileSync(
      path.join(envctl, 'lock.json'),
      JSON.stringify({
        apiVersion: 'dshenv-lock/v1',
        profiles: { web: { plugins: { extra: { package: 'extra-plugin', source: { type: 'npm', resolvedVersion: '1.0.0' } } } } }
      })
    );
    const argsFile = path.join(tempHome, 'dsh-args.json');
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(
      fakeDsh,
      `import fs from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.1.7-rc.2'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(args));
process.exit(1);
`
    );
    const previousDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
    try {
      const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
      await expect(applyEnvironment(paths, { overlay: { name: 'laptop', via: 'flag' } })).rejects.toThrow();
    } finally {
      if (previousDshCli === undefined) delete process.env.DSH_CLI;
      else process.env.DSH_CLI = previousDshCli;
    }
    expect(JSON.parse(fs.readFileSync(argsFile, 'utf8'))).toContain('extra-plugin@2.0.0');
  });

  it('records a newly selected overlay even when there is nothing to apply', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.copyFileSync(path.join(tempHome, 'envctl', 'overlays', 'laptop.yaml'), path.join(tempHome, 'envctl', 'overlays', 'desk.yaml'));
    await applyEnvironment(paths, { overlay: { name: 'laptop', via: 'flag' } });

    const noop = await applyEnvironment(paths, { overlay: { name: 'desk', via: 'flag' } });
    expect(noop.applied).toBe(false);
    expect(loadState(fs.readFileSync(paths.stateFile, 'utf8')).appliedOverlay).toBe('desk');

    await applyEnvironment(paths, { overlay: { name: 'laptop', via: 'flag' }, dryRun: true });
    expect(loadState(fs.readFileSync(paths.stateFile, 'utf8')).appliedOverlay).toBe('desk');
  });
});
