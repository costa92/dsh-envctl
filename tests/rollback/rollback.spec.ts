import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment } from '../../src/apply/apply.js';
import { rollbackEnvironment } from '../../src/rollback/rollback.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { readJournalEntries } from '../../src/io/journal.js';
import { createEnvironmentSnapshot } from '../../src/io/backup.js';

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
          JSON.stringify({ name: '@nanmicoder/dsh-agent-teams', version: '0.1.21', dsh: { bundle: {} } })
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
          JSON.stringify({ name: '@nanmicoder/dsh-agent-teams', version: '0.1.21', dsh: { bundle: {} } })
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

  it('saves the files it replaces so the rollback itself can be undone', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await createEnvironmentSnapshot(paths, 'apply-1');
    const handEdited = 'apiVersion: dshenv/v1\nprofiles:\n  api:\n    plugins: {}\n';
    fs.writeFileSync(paths.manifestFile, handEdited);

    const result = await rollbackEnvironment(paths, { operationId: 'apply-1' });
    const restored = fs.readFileSync(paths.manifestFile, 'utf8');
    expect(restored).not.toBe(handEdited);
    expect(result.backupSnapshotId).toMatch(/rollback/);

    // The saved snapshot must not be mistaken for the one it was taken against.
    await rollbackEnvironment(paths, { operationId: 'apply-1' });
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(restored);

    await rollbackEnvironment(paths, { operationId: result.backupSnapshotId });
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe(handEdited);
  });

  it('removes files that did not exist when the snapshot was taken', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.rmSync(paths.lockFile);
    await createEnvironmentSnapshot(paths, 'apply-2');
    fs.writeFileSync(paths.lockFile, '{"apiVersion":"dshenv-lock/v1","profiles":{}}');

    await rollbackEnvironment(paths, { operationId: 'apply-2' });
    expect(fs.existsSync(paths.lockFile)).toBe(false);
  });
});
