import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment } from '../../src/apply/apply.js';
import { rollbackEnvironment } from '../../src/rollback/rollback.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { readJournalEntries } from '../../src/io/journal.js';

describe('rollbackEnvironment', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-rollback-'));
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
      `{"apiVersion":"dshenv-lock/v1","profiles":{"web":{"plugins":{}}}}`
    );
    fs.writeFileSync(
      path.join(managerDir, 'state.json'),
      `{"apiVersion":"dshenv-state/v1","lastApplied":"2026-01-01T00:00:00.000Z","appliedLockHash":"","profiles":{},"ownership":{}}`
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should restore the previous manifest from the latest apply snapshot', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const original = fs.readFileSync(paths.manifestFile, 'utf8');

    await applyEnvironment(paths, {
      executor: async () => {
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
        return { success: true };
      }
    });

    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles: {}\n');
    const result = await rollbackEnvironment(paths);
    expect(result.rolledBack).toBe(true);
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(original);
    const journal = await readJournalEntries(paths);
    expect(journal.some((entry) => entry.type === 'rollback-completed')).toBe(true);
  });

  it('should preview rollback without writing when dry-run', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await applyEnvironment(paths, {
      executor: async () => {
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
        return { success: true };
      }
    });
    fs.writeFileSync(paths.manifestFile, 'changed\n');
    const result = await rollbackEnvironment(paths, { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe('changed\n');
  });
});
