import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { acquireEnvironmentLock } from '../../src/io/lock.js';
import { createEnvironmentSnapshot, restoreEnvironmentSnapshot } from '../../src/io/backup.js';
import { appendJournalEntry, readJournalEntries } from '../../src/io/journal.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

describe('Lock, Backup and Journal IO', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-lock-test-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should acquire and release exclusive environment lock', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockHandle = await acquireEnvironmentLock(paths);
    expect(lockHandle).toBeDefined();

    // Trying to acquire second lock should fail
    await expect(acquireEnvironmentLock(paths)).rejects.toThrow(/already held/i);

    // Release lock
    await lockHandle.release();

    // Now acquiring should succeed again
    const lockHandle2 = await acquireEnvironmentLock(paths);
    await lockHandle2.release();
  });

  it('should create and restore snapshot', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\n');

    const snapshot = await createEnvironmentSnapshot(paths, 'test-op-1');
    expect(snapshot.snapshotDir).toContain('test-op-1');
    expect(fs.existsSync(path.join(snapshot.snapshotDir, 'manifest.yaml'))).toBe(true);

    // Modify original
    fs.writeFileSync(paths.manifestFile, 'modified\n');

    // Restore
    await restoreEnvironmentSnapshot(snapshot, paths);
    expect(fs.readFileSync(paths.manifestFile, 'utf8')).toBe('apiVersion: dshenv/v1\n');
  });

  it('should append and read journal entries', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    await appendJournalEntry(paths, {
      operationId: 'op-123',
      type: 'apply-started',
      timestamp: new Date().toISOString(),
      details: { foo: 'bar' }
    });

    const entries = await readJournalEntries(paths);
    expect(entries).toHaveLength(1);
    expect(entries[0].operationId).toBe('op-123');
    expect(entries[0].type).toBe('apply-started');
  });
});
