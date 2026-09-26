import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { writeAtomic } from './atomic-file.js';

export interface EnvironmentSnapshot {
  snapshotId: string;
  snapshotDir: string;
  timestamp: string;
}

export async function createEnvironmentSnapshot(
  paths: EnvironmentPaths,
  operationId: string
): Promise<EnvironmentSnapshot> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const snapshotId = `${timestamp}-${operationId}`;
  const snapshotDir = path.join(paths.backupsDir, snapshotId);

  await fs.promises.mkdir(snapshotDir, { recursive: true });

  const filesToBackup = [paths.manifestFile, paths.lockFile, paths.stateFile];
  for (const file of filesToBackup) {
    if (fs.existsSync(file)) {
      const dest = path.join(snapshotDir, path.basename(file));
      await fs.promises.copyFile(file, dest);
    }
  }

  return {
    snapshotId,
    snapshotDir,
    timestamp
  };
}

export async function restoreEnvironmentSnapshot(
  snapshot: EnvironmentSnapshot,
  paths: EnvironmentPaths
): Promise<void> {
  // A file absent from the snapshot did not exist then, so it must not survive the restore either.
  for (const file of [paths.manifestFile, paths.lockFile, paths.stateFile]) {
    const saved = path.join(snapshot.snapshotDir, path.basename(file));
    if (fs.existsSync(saved)) {
      await writeAtomic(file, await fs.promises.readFile(saved), 'overwrite');
    } else {
      await fs.promises.rm(file, { force: true });
    }
  }
}

export async function listEnvironmentSnapshots(paths: EnvironmentPaths): Promise<EnvironmentSnapshot[]> {
  if (!fs.existsSync(paths.backupsDir)) {
    return [];
  }

  const entries = await fs.promises.readdir(paths.backupsDir, { withFileTypes: true });
  const snapshots: EnvironmentSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    snapshots.push({
      snapshotId: entry.name,
      snapshotDir: path.join(paths.backupsDir, entry.name),
      timestamp: entry.name
    });
  }
  snapshots.sort((a, b) => b.snapshotId.localeCompare(a.snapshotId));
  return snapshots;
}

export async function findEnvironmentSnapshot(
  paths: EnvironmentPaths,
  operationId?: string
): Promise<EnvironmentSnapshot> {
  const snapshots = await listEnvironmentSnapshots(paths);
  if (snapshots.length === 0) {
    throw new Error('No environment snapshots found');
  }

  if (!operationId) {
    return snapshots[0];
  }

  const match = snapshots.find(
    (snapshot) => snapshot.snapshotId === operationId || snapshot.snapshotId.endsWith(`-${operationId}`)
  );
  if (!match) {
    throw new Error(`Snapshot not found for operation: ${operationId}`);
  }
  return match;
}
