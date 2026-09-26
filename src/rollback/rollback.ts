import type { EnvironmentPaths } from '../environment/paths.js';
import { acquireEnvironmentLock } from '../io/lock.js';
import { findEnvironmentSnapshot, restoreEnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { ValidationError } from '../errors.js';

export interface RollbackOptions {
  operationId?: string;
  dryRun?: boolean;
}

export interface RollbackResult {
  rolledBack: boolean;
  dryRun: boolean;
  snapshotId: string;
  operationId?: string;
  message: string;
}

export async function rollbackEnvironment(
  paths: EnvironmentPaths,
  options?: RollbackOptions
): Promise<RollbackResult> {
  let snapshot;
  try {
    snapshot = await findEnvironmentSnapshot(paths, options?.operationId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(message);
  }

  if (options?.dryRun) {
    return {
      rolledBack: false,
      dryRun: true,
      snapshotId: snapshot.snapshotId,
      operationId: options.operationId,
      message: `Would restore snapshot ${snapshot.snapshotId}`
    };
  }

  const operationId = `rollback-${snapshot.snapshotId}`;
  const lockHandle = await acquireEnvironmentLock(paths);
  try {
    await appendJournalEntry(paths, {
      operationId,
      type: 'rollback-started',
      timestamp: new Date().toISOString(),
      details: { snapshotId: snapshot.snapshotId, targetOperationId: options?.operationId }
    });
    await restoreEnvironmentSnapshot(snapshot, paths);
    await appendJournalEntry(paths, {
      operationId,
      type: 'rollback-completed',
      timestamp: new Date().toISOString(),
      details: { snapshotId: snapshot.snapshotId }
    });
    return {
      rolledBack: true,
      dryRun: false,
      snapshotId: snapshot.snapshotId,
      operationId: options?.operationId,
      message: `Restored snapshot ${snapshot.snapshotId}`
    };
  } finally {
    await lockHandle.release();
  }
}
