import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { loadState, loadLock } from '../../src/manifest/files.js';

describe('applyEnvironment', () => {
  let tempHome: string;
  let previousDshCli: string | undefined;

  beforeEach(() => {
    previousDshCli = process.env.DSH_CLI;
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-test-'));
    const managerDir = path.join(tempHome, 'envctl');
    fs.mkdirSync(managerDir, { recursive: true });

    // Write empty manifest and lock
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
  "profiles": {},
  "ownership": {
    "web": {
      "@nanmicoder/dsh-agent-teams": {
        "package": "@nanmicoder/dsh-agent-teams",
        "alias": "agent-teams",
        "sourceType": "npm",
        "lockedVersion": "0.1.21",
        "adoptedAt": "2026-01-01T00:00:00.000Z",
        "adoptedBy": "test"
      }
    }
  }
}`
    );
  });

  afterEach(() => {
    if (previousDshCli === undefined) delete process.env.DSH_CLI;
    else process.env.DSH_CLI = previousDshCli;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  function installDeclaredPlugin(): void {
    const profileDir = path.join(tempHome, 'profiles', 'web');
    const packageDir = path.join(profileDir, 'node_modules', '@nanmicoder', 'dsh-agent-teams');
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: { '@nanmicoder/dsh-agent-teams': '0.1.21' },
        dsh: { profile: { bundles: ['@nanmicoder/dsh-agent-teams'] } }
      })
    );
    fs.writeFileSync(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: '@nanmicoder/dsh-agent-teams', version: '0.1.21' })
    );
  }

  it('should perform dry-run apply without modifying state', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const res = await applyEnvironment(paths, { dryRun: true });

    expect(res.dryRun).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.plan.hasChanges).toBe(true);

    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(state.lastApplied).toBe('2026-01-01T00:00:00.000Z');
  });

  it('should apply changes, create snapshot, journal and update state.json', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const res = await applyEnvironment(paths, {
      dryRun: false,
      executor: async () => {
        installDeclaredPlugin();
        return { success: true };
      }
    });

    expect(res.applied).toBe(true);
    expect(res.operationId).toBeDefined();

    // Verify snapshot created
    expect(fs.existsSync(paths.backupsDir)).toBe(true);
    const backups = fs.readdirSync(paths.backupsDir);
    expect(backups.length).toBeGreaterThan(0);

    // Verify state updated
    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(state.lastApplied).not.toBe('2026-01-01T00:00:00.000Z');
    expect(state.appliedLockHash).toBeTruthy();

    // Verify journal appended
    const journalFile = path.join(paths.logsDir, 'journal.jsonl');
    expect(fs.existsSync(journalFile)).toBe(true);
    const journalContent = fs.readFileSync(journalFile, 'utf8');
    expect(journalContent).toContain('apply-completed');
  });

  it('should reject a successful executor when the environment remains drifted', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });

    await expect(applyEnvironment(paths, {
      executor: async () => ({ success: true })
    })).rejects.toThrow('environment still has pending operations');

    const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
    expect(state.lastApplied).toBe('2026-01-01T00:00:00.000Z');
  });

  it('should execute install operations through the configured DSH CLI by default', async () => {
    const fakeDsh = path.join(tempHome, 'fake-dsh.mjs');
    fs.writeFileSync(fakeDsh, `
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const profile = args[args.indexOf('--profile') + 1];
const spec = args.at(-1);
const packageName = spec.startsWith('@') ? spec.slice(0, spec.indexOf('@', 1)) : spec.split('@')[0];
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

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);

    expect(result.applied).toBe(true);
    const profile = JSON.parse(fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), 'utf8'));
    expect(profile.dependencies).toEqual({ '@nanmicoder/dsh-agent-teams': '0.1.21' });
  });

  it('should enable an installed plugin by updating dsh.profile.bundles without invoking DSH CLI', async () => {
    installDeclaredPlugin();
    const profileJson = path.join(tempHome, 'profiles', 'web', 'package.json');
    const profile = JSON.parse(fs.readFileSync(profileJson, 'utf8')) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    profile.dsh.profile.bundles = [];
    fs.writeFileSync(profileJson, JSON.stringify(profile, null, 2));

    const marker = path.join(tempHome, 'dsh-was-called');
    const fakeDsh = path.join(tempHome, 'must-not-run.mjs');
    fs.writeFileSync(fakeDsh, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(1);`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);
    expect(result.applied).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    const next = JSON.parse(fs.readFileSync(profileJson, 'utf8')) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    expect(next.dsh.profile.bundles).toContain('@nanmicoder/dsh-agent-teams');
    expect(next.dependencies['@nanmicoder/dsh-agent-teams']).toBe('0.1.21');
  });

  it('should disable an installed plugin by removing it from bundles and keeping the dependency', async () => {
    installDeclaredPlugin();
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: false
        source:
          type: npm
          version: "0.1.21"
`
    );

    const marker = path.join(tempHome, 'dsh-was-called');
    const fakeDsh = path.join(tempHome, 'must-not-run.mjs');
    fs.writeFileSync(fakeDsh, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'called'); process.exit(1);`);
    process.env.DSH_CLI = JSON.stringify([process.execPath, fakeDsh]);

    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const result = await applyEnvironment(paths);
    expect(result.applied).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    const next = JSON.parse(
      fs.readFileSync(path.join(tempHome, 'profiles', 'web', 'package.json'), 'utf8')
    ) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } };
    expect(next.dsh.profile.bundles).not.toContain('@nanmicoder/dsh-agent-teams');
    expect(next.dependencies['@nanmicoder/dsh-agent-teams']).toBe('0.1.21');
  });
});
