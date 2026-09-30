import * as crypto from 'node:crypto';
import type { EnvironmentPaths } from '../environment/paths.js';
import { acquireEnvironmentLock } from '../io/lock.js';
import {
  createEnvironmentSnapshot,
  findEnvironmentSnapshot,
  listEnvironmentSnapshots,
  readAbsentKeys,
  restoreEnvironmentSnapshot,
  snapshotOverlayKeys,
  type EnvironmentSnapshot
} from '../io/backup.js';
import { appendJournalEntry, readJournalEntries } from '../io/journal.js';
import { ValidationError } from '../errors.js';
import { overlayFilePath, readSelectionFile, writeSelectionFile } from '../overlay/selection.js';
import { loadLock, loadManifest, loadState, serializeState, withResources } from '../manifest/files.js';
import * as path from 'node:path';
import { writeAtomic } from '../io/atomic-file.js';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import type { EnvironmentState } from '../domain.js';
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

function readState(paths: EnvironmentPaths): EnvironmentState | null {
  try {
    return fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
  } catch {
    return null;
  }
}

// Rollback leaves the profiles alone, so a plugin an apply installed is still installed and must stay dshenv's to remove.
async function keepInstalledOwnership(paths: EnvironmentPaths, before: EnvironmentState | null): Promise<void> {
  const restored = readState(paths);
  if (!before?.resources?.plugin || (fs.existsSync(paths.stateFile) && !restored)) {
    return;
  }
  const inventory = await readEnvironmentInventory(paths);
  const next: EnvironmentState = restored ?? { apiVersion: 'dshenv-state/v2', lastApplied: '', appliedLockHash: '', profiles: {} };
  const plugin = structuredClone(next.resources?.plugin ?? {});
  let changed = false;
  for (const [profile, packages] of Object.entries(before.resources.plugin)) {
    for (const [packageName, record] of Object.entries(packages)) {
      // Adopted plugins were DSH's before; rolling back an adopt gives them back.
      if (!record.adoptedBy.startsWith('apply-') || plugin[profile]?.[packageName] || !inventory.profiles[profile]?.plugins[packageName]?.installed) {
        continue;
      }
      (plugin[profile] ??= {})[packageName] = record;
      changed = true;
    }
  }
  if (changed) {
    await writeAtomic(paths.stateFile, serializeState(withResources(next, { plugin })), 'overwrite');
  }
}

// Restoring a file that does not parse would leave every later command failing on it.
function assertSnapshotReadable(snapshotId: string, snapshotDir: string): void {
  const loaders: Array<[string, (content: string) => unknown]> = [
    ['manifest.yaml', loadManifest],
    ['lock.json', loadLock],
    ['state.json', loadState]
  ];
  for (const [file, load] of loaders) {
    const saved = path.join(snapshotDir, file);
    if (!fs.existsSync(saved)) {
      continue;
    }
    try {
      load(fs.readFileSync(saved, 'utf8'));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ValidationError(`Snapshot ${snapshotId} cannot be restored: its ${file} is invalid (${message})`);
    }
  }
}

// A snapshot id is `<timestamp>-<operation id>`, the timestamp an ISO time with ':' and '.' replaced by '-'.
function snapshotOperationId(snapshotId: string): string {
  return snapshotId.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-/, '');
}

// Applies that failed and put their own lock.json and state.json back; restoring their snapshot changes nothing.
async function selfUndoneApplies(paths: EnvironmentPaths): Promise<Set<string>> {
  return new Set((await readJournalEntries(paths)).filter((entry) => entry.type === 'apply-rollback').map((entry) => entry.operationId));
}

// The latest apply that completed and whose snapshot still exists: its snapshot holds the manifest it applied.
export async function lastSuccessfulApply(paths: EnvironmentPaths): Promise<string | null> {
  const snapshots = new Set((await listEnvironmentSnapshots(paths)).map((snapshot) => snapshotOperationId(snapshot.snapshotId)));
  const completed = (await readJournalEntries(paths)).filter((entry) => entry.type === 'apply-completed' && snapshots.has(entry.operationId));
  return completed.at(-1)?.operationId ?? null;
}

// Without an id, the latest snapshot that is not from a failed apply: that one already undid itself.
async function pickSnapshot(paths: EnvironmentPaths, operationId: string | undefined): Promise<{ snapshot: EnvironmentSnapshot; skipped: string[] }> {
  if (operationId) {
    return { snapshot: await findEnvironmentSnapshot(paths, operationId), skipped: [] };
  }
  const snapshots = await listEnvironmentSnapshots(paths);
  if (snapshots.length === 0) {
    throw new Error('No environment snapshots found');
  }
  const undone = await selfUndoneApplies(paths);
  const skipped: string[] = [];
  for (const snapshot of snapshots) {
    const id = snapshotOperationId(snapshot.snapshotId);
    if (!undone.has(id)) {
      return { snapshot, skipped };
    }
    skipped.push(id);
  }
  throw new Error(
    `Every snapshot left is from a failed apply that already undid itself (${skipped.join(', ')}); name one to restore it anyway: dshenv rollback <operation-id> --yes`
  );
}

export async function rollbackEnvironment(
  paths: EnvironmentPaths,
  options?: RollbackOptions
): Promise<RollbackResult> {
  let picked;
  try {
    picked = await pickSnapshot(paths, options?.operationId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(message);
  }
  const { snapshot, skipped } = picked;
  assertSnapshotReadable(snapshot.snapshotId, snapshot.snapshotDir);
  // "As they were before apply-X" read as undoing apply-X; the snapshot holds the manifest it applied.
  const snapshotOf = snapshotOperationId(snapshot.snapshotId);
  const target = snapshotOf.startsWith('apply-')
    ? `saved when ${snapshotOf} started (snapshot ${snapshot.snapshotId}): the manifest it applied, with lock.json and state.json from before it ran`
    : `saved when ${snapshotOf} started (snapshot ${snapshot.snapshotId})`;
  const skippedNote =
    skipped.length > 0 ? `; skipped ${skipped.join(', ')}, which failed and had already undone its own changes` : '';

  if (options?.dryRun) {
    return {
      rolledBack: false,
      dryRun: true,
      snapshotId: snapshot.snapshotId,
      operationId: options.operationId,
      message: `Would restore the envctl files ${target}${skippedNote}`
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
    // Overlays the restore overwrites or deletes may hold local edits by now, so the backup must hold them too.
    const backup = await createEnvironmentSnapshot(paths, `pre-rollback-${crypto.randomBytes(6).toString('hex')}`, {
      overlayKeys: snapshotOverlayKeys(snapshot)
    });
    const before = readState(paths);
    await restoreEnvironmentSnapshot(snapshot, paths);
    await keepInstalledOwnership(paths, before);
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
      message: `Restored the envctl files ${target}; the files it replaced are saved as snapshot ${backup.snapshotId}${skippedNote}`
    };
  } finally {
    await lockHandle.release();
  }
}
