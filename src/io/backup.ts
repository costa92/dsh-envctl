import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';

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
  const files = await fs.promises.readdir(snapshot.snapshotDir);
  for (const file of files) {
    const src = path.join(snapshot.snapshotDir, file);
    const dest = path.join(paths.managerDir, file);
    await fs.promises.copyFile(src, dest);
  }
}
