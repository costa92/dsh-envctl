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
    await expect(acquireEnvironmentLock(paths, 50)).rejects.toThrow(/already held/i);

    // Release lock
    await lockHandle.release();

    // Now acquiring should succeed again
    const lockHandle2 = await acquireEnvironmentLock(paths);
    await lockHandle2.release();
  });

  it('should wait for a held lock to be released within the timeout', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const holder = await acquireEnvironmentLock(paths);
    setTimeout(() => void holder.release(), 150);

    const waiter = await acquireEnvironmentLock(paths, 2000);
    await waiter.release();
  });

  it('should give up once the timeout elapses', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const holder = await acquireEnvironmentLock(paths);
    const started = Date.now();

    await expect(acquireEnvironmentLock(paths, 300)).rejects.toThrow(/already held/i);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await holder.release();
  });

  it('should not steal a lock whose holder has not written its content yet', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    fs.writeFileSync(lockFile, '');

    await expect(acquireEnvironmentLock(paths, 200)).rejects.toThrow(/already held/i);
    expect(fs.readFileSync(lockFile, 'utf8')).toBe('');
  });

  it('should let only one of several concurrent waiters reclaim a stale lock', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    for (let round = 0; round < 200; round++) {
      // A pid that cannot belong to a live process marks the lock as stale.
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 31 - 1, hostname: os.hostname() }));
      const results = await Promise.allSettled(
        Array.from({ length: 32 }, () => acquireEnvironmentLock(paths, 0))
      );
      const winners = results.filter((result) => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      fs.rmSync(lockFile, { force: true });
    }
  });

  it('should point at a reclaim marker left by a crashed reclaimer instead of removing it', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 31 - 1, hostname: os.hostname() }));
    const guard = `${lockFile}.reclaim`;
    fs.mkdirSync(guard);
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(guard, past, past);

    await expect(acquireEnvironmentLock(paths, 0)).rejects.toThrow(/stale reclaim marker/);
    expect(fs.existsSync(guard)).toBe(true);
  });

  it('should reclaim an unreadable lock left behind long ago', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    const lockFile = path.join(paths.managerDir, 'dshenv.lock');
    fs.writeFileSync(lockFile, '');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lockFile, past, past);

    const handle = await acquireEnvironmentLock(paths, 200);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
    await handle.release();
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
