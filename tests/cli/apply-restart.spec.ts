import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

const PKG = '@nanmicoder/dsh-agent-teams';

describe('CLI apply restart report', () => {
  let tempHome: string;
  let previousDshCli: string | undefined;

  const run = async (args: string[]) => {
    let stdout = '';
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: (chunk) => { stdout += chunk; },
      stderr: (chunk) => { stderr += chunk; }
    });
    return { code, stdout, stderr };
  };

  const profileJson = (): string => path.join(tempHome, 'profiles', 'web', 'package.json');

  // Fake dsh: --dump-config prints an hmr row with the given disabled line; plugin add installs the spec.
  const configureFakeDsh = (hmrDisabled: string): void => {
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    const dump = `- id: hmr\n  name: '@deepseek-ai/dsh-hmr'\n  disabled: ${hmrDisabled}\n`;
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('0.1.7-rc.2'); process.exit(0); }
if (args.includes('--dump-config')) { process.stdout.write(${JSON.stringify(dump)}); process.exit(0); }
const profile = args[args.indexOf('--profile') + 1];
const spec = args.at(-1);
const name = spec.slice(0, spec.indexOf('@', 1));
const version = spec.slice(name.length + 1);
const profileDir = path.join(process.env.DSH_HOME, 'profiles', profile);
const pkgJsonPath = path.join(profileDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
pkg.dependencies[name] = version;
fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg));
const dir = path.join(profileDir, 'node_modules', ...name.split('/'));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  };

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-apply-restart-'));
    const managerDir = path.join(tempHome, 'envctl');
    fs.mkdirSync(managerDir, { recursive: true });
    fs.writeFileSync(
      path.join(managerDir, 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "${PKG}"
        enabled: true
        source: { type: npm, version: "0.1.21" }
      other:
        package: other-plugin
        enabled: true
        source: { type: npm, version: "2.0.0" }
`
    );
    fs.writeFileSync(
      path.join(managerDir, 'state.json'),
      JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: '2026-01-01T00:00:00.000Z', appliedLockHash: '', profiles: {} })
    );
    // agent-teams is installed but not enabled (enable); other-plugin is at 1.0.0 (update).
    const profileDir = path.join(tempHome, 'profiles', 'web');
    for (const [name, version] of [[PKG, '0.1.21'], ['other-plugin', '1.0.0']]) {
      const dir = path.join(profileDir, 'node_modules', ...name.split('/'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
    }
    fs.writeFileSync(
      profileJson(),
      JSON.stringify({ dependencies: { [PKG]: '0.1.21', 'other-plugin': '1.0.0' }, dsh: { profile: { bundles: ['other-plugin'] } } })
    );
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('groups applied operations by whether DSH must restart', async () => {
    configureFakeDsh("!!js '!ctx.get(''profileContext'')'");

    const { code, stdout } = await run(['apply', '--yes']);

    expect(code).toBe(0);
    const summary = stdout.slice(stdout.indexOf('No restart needed:'));
    expect(summary).toBe(
      [
        'No restart needed:',
        `  [web] enable ${PKG}`,
        'Restart DSH to load:',
        '  [web] update other-plugin (package updates are not hot-reloaded)',
        'Then run: dshenv restarted',
        ''
      ].join('\n')
    );
    expect(stdout.indexOf('Successfully applied changes')).toBeLessThan(stdout.indexOf('No restart needed:'));
  });

  it('reports hot reload off for every operation of the profile', async () => {
    configureFakeDsh('true');

    const { stdout } = await run(['apply', '--yes']);

    expect(stdout).not.toContain('No restart needed:');
    expect(stdout).toContain(`  [web] enable ${PKG} (hot reload is off for profile web)\n`);
    expect(stdout).toContain('Then run: dshenv restarted\n');
  });

  it('adds the restart field to --json output', async () => {
    configureFakeDsh("!!js '!ctx.get(''profileContext'')'");

    const { code, stdout } = await run(['--json', 'apply', '--yes']);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { applied: boolean; restart: unknown };
    expect(parsed.applied).toBe(true);
    expect(parsed.restart).toEqual({
      notRequired: [{ profile: 'web', package: PKG, kind: 'enable', reason: 'hmr-on' }],
      required: [{ profile: 'web', package: 'other-plugin', kind: 'update', reason: 'package-update' }]
    });
  });

  it('annotates dry-run operations and writes nothing', async () => {
    configureFakeDsh("!!js '!ctx.get(''profileContext'')'");
    const before = fs.readFileSync(profileJson(), 'utf8');

    const { code, stdout } = await run(['apply', '--dry-run']);

    expect(code).toBe(0);
    expect(stdout).toContain(`[web] ${PKG} (agent-teams) enabled: true (no restart)\n`);
    expect(stdout).toContain('[web] other-plugin (other) 1.0.0 -> 2.0.0 (restart required: package updates are not hot-reloaded)\n');
    expect(stdout).not.toContain('Then run:');
    expect(fs.readFileSync(profileJson(), 'utf8')).toBe(before);
  });

  it('includes the restart field in dry-run JSON', async () => {
    configureFakeDsh('true');

    const { stdout } = await run(['--json', 'apply', '--dry-run']);

    const parsed = JSON.parse(stdout) as { dryRun: boolean; restart: { required: unknown[] } };
    expect(parsed.dryRun).toBe(true);
    expect(parsed.restart.required).toHaveLength(2);
  });

  it('prints no restart groups when the environment is in sync', async () => {
    configureFakeDsh('true');
    fs.writeFileSync(
      profileJson(),
      JSON.stringify({ dependencies: { [PKG]: '0.1.21', 'other-plugin': '1.0.0' }, dsh: { profile: { bundles: [PKG, 'other-plugin'] } } })
    );
    const manifestPath = path.join(tempHome, 'envctl', 'manifest.yaml');
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath, 'utf8').replace('"2.0.0"', '"1.0.0"'));

    const { stdout } = await run(['apply', '--yes']);

    expect(stdout).not.toContain('No restart needed:');
    expect(stdout).not.toContain('Restart DSH to load:');
  });
});
