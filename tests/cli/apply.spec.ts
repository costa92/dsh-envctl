import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI apply', () => {
  let tempHome: string;
  let previousDshCli: string | undefined;

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-apply-'));
    const managerDir = path.join(tempHome, 'envctl');
    fs.mkdirSync(managerDir, { recursive: true });

    fs.writeFileSync(
      path.join(managerDir, 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
`
    );

    fs.writeFileSync(
      path.join(managerDir, 'lock.json'),
      `{
  "apiVersion": "dshenv-lock/v1",
  "profiles": {
    "web": {
      "plugins": {
        "agent-teams": {
          "package": "@nanmicoder/dsh-agent-teams",
          "source": {
            "type": "npm",
            "resolvedVersion": "0.1.21"
          }
        }
      }
    }
  }
}`
    );

    fs.writeFileSync(
      path.join(managerDir, 'state.json'),
      `{
  "apiVersion": "dshenv-state/v1",
  "lastApplied": "2026-01-01T00:00:00.000Z",
  "appliedLockHash": "",
  "profiles": {}
}`
    );
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function configureFakeDsh(): void {
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const profile = args[args.indexOf('--profile') + 1];
const spec = args.at(-1);
const packageName = spec.slice(0, spec.indexOf('@', 1));
const version = spec.slice(packageName.length + 1);
const profileDir = path.join(process.env.DSH_HOME, 'profiles', profile);
const packageDir = path.join(profileDir, 'node_modules', ...packageName.split('/'));
fs.mkdirSync(packageDir, { recursive: true });
fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
  name: 'dsh-profile-' + profile,
  private: true,
  dependencies: { [packageName]: version },
  dsh: { profile: { bundles: [packageName] } }
}));
fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version }));
`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);
  }

  it('should support dry-run apply via CLI apply --dry-run', async () => {
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    const code = await runCli(['apply', '--dry-run', '--dsh-home', tempHome], io);
    expect(code).toBe(0);
    expect(stdout).toContain('[DRY-RUN]');
    expect(stdout).toContain('@nanmicoder/dsh-agent-teams');
  });

  it('should apply changes via CLI apply --yes', async () => {
    configureFakeDsh();
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    const code = await runCli(['apply', '--yes', '--dsh-home', tempHome], io);
    expect(code).toBe(0);
    expect(stdout).toContain('Successfully applied');
    const profile = JSON.parse(fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), 'utf8'));
    expect(profile.dependencies).toEqual({ '@nanmicoder/dsh-agent-teams': '0.1.21' });
  });

  it('should refuse a real apply without --yes', async () => {
    configureFakeDsh();
    let stderr = '';
    const io = {
      stdout: () => {},
      stderr: (chunk: string) => {
        stderr += chunk;
      }
    };

    const code = await runCli(['apply', '--dsh-home', tempHome], io);
    expect(code).toBe(3);
    expect(stderr).toMatch(/--yes/);
    expect(fs.existsSync(path.join(tempHome, 'profiles', 'web', 'package.json'))).toBe(false);
  });
});
