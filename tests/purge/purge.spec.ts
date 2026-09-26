import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { purgePlugin } from '../../src/purge/purge.js';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

describe('purgePlugin', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-purge-'));
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
        patches:
          - id: agent-teams
            config:
              taskPlanning: captain
`
    );
    fs.writeFileSync(
      path.join(managerDir, 'lock.json'),
      `{"apiVersion":"dshenv-lock/v1","profiles":{"web":{"plugins":{}}}}`
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
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should refuse unmanaged plugins', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await expect(purgePlugin(paths, 'web', 'stray-pkg')).rejects.toThrow(/no ownership/);
  });

  it('should copy managed patch into trash and strip the live block', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await applyEnvironment(paths);
    const patchFile = path.join(tempHome, 'profiles', 'web', 'cordis.patch.yml');
    expect(fs.readFileSync(patchFile, 'utf8')).toContain('dshenv:begin');

    const result = await purgePlugin(paths, 'web', 'agent-teams');
    expect(result.moved.length).toBeGreaterThan(0);
    expect(fs.readFileSync(patchFile, 'utf8')).not.toContain('dshenv:begin');
    expect(result.moved.some((item) => item.includes('cordis.patch.yml'))).toBe(true);
  });
});
