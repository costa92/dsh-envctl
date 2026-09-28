import * as crypto from 'node:crypto';
import type { EnvironmentPaths } from '../environment/paths.js';
import { acquireEnvironmentLock } from '../io/lock.js';
import { createEnvironmentSnapshot, findEnvironmentSnapshot, readAbsentKeys, restoreEnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { ValidationError } from '../errors.js';
import { overlayFilePath, readSelectionFile, writeSelectionFile } from '../overlay/selection.js';
import * as fs from 'node:fs';

export interface RollbackOptions {
  operationId?: string;
  dryRun?: boolean;
}

export interface RollbackResult {
  rolledBack: boolean;
  dryRun: boolean;
  snapshotId: string;
  operationId?: string;
  // Snapshot of the files the rollback replaced; rolling back to it undoes the rollback.
  backupSnapshotId?: string;
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
    // A fresh id, so lookups by the restored snapshot's operation id never match this backup.
    // Files the restore deletes as absent may be local by now, so the backup must hold them too.
    const backup = await createEnvironmentSnapshot(paths, `pre-rollback-${crypto.randomBytes(6).toString('hex')}`, {
      overlayKeys: readAbsentKeys(snapshot)
    });
    await restoreEnvironmentSnapshot(snapshot, paths);
    // A pull may have created and selected the overlay the restore just removed; a selection of nothing breaks every command.
    const selected = readSelectionFile(paths);
    if (selected && !fs.existsSync(overlayFilePath(paths, selected)) && readAbsentKeys(snapshot).includes(`overlays/${selected}.yaml`)) {
      await writeSelectionFile(paths, null);
    }
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
      backupSnapshotId: backup.snapshotId,
      message: `Restored snapshot ${snapshot.snapshotId}; replaced files saved as snapshot ${backup.snapshotId}`
    };
  } finally {
    await lockHandle.release();
  }
}
