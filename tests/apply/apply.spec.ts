import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { applyEnvironment } from '../../src/apply/apply.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';
import { loadState, loadLock } from '../../src/manifest/files.js';

describe('applyEnvironment', () => {
  let tempHome: string;

  beforeEach(() => {
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
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

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
        // mock successful execution of operations
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
});
