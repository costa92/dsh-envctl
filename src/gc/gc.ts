import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { acquireEnvironmentLock } from '../io/lock.js';
import { appendJournalEntry } from '../io/journal.js';
import { ValidationError } from '../errors.js';

export interface GcOptions {
  olderThanDays?: number;
  dryRun?: boolean;
}

export interface GcResult {
  dryRun: boolean;
  deleted: string[];
  skipped: string[];
  message: string;
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function collectTrashGcTargets(
  paths: EnvironmentPaths,
  olderThanDays: number
): Promise<{ deleted: string[]; skipped: string[] }> {
  if (olderThanDays < 0) {
    throw new ValidationError('olderThanDays must be >= 0');
  }
  const deleted: string[] = [];
  const skipped: string[] = [];
  if (!fs.existsSync(paths.trashDir)) {
    return { deleted, skipped };
  }

  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const entries = await fs.promises.readdir(paths.trashDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(paths.trashDir, entry.name);
    if (!isPathInside(paths.trashDir, fullPath)) {
      skipped.push(fullPath);
      continue;
    }
    const stat = await fs.promises.lstat(fullPath);
    if (stat.mtimeMs > cutoff) {
      skipped.push(fullPath);
      continue;
    }
    deleted.push(fullPath);
  }
  return { deleted, skipped };
}

export async function gcEnvironment(
  paths: EnvironmentPaths,
  options?: GcOptions
): Promise<GcResult> {
  const olderThanDays = options?.olderThanDays ?? 7;
  const targets = await collectTrashGcTargets(paths, olderThanDays);

  if (options?.dryRun) {
    return {
      dryRun: true,
      deleted: targets.deleted,
      skipped: targets.skipped,
      message: `Would delete ${String(targets.deleted.length)} trash item(s)`
    };
  }

  const lockHandle = await acquireEnvironmentLock(paths);
  try {
    const operationId = `gc-${Date.now().toString(16)}`;
    await appendJournalEntry(paths, {
      operationId,
      type: 'gc-started',
      timestamp: new Date().toISOString(),
      details: { olderThanDays, count: targets.deleted.length }
    });

    for (const target of targets.deleted) {
      if (!isPathInside(paths.trashDir, target)) {
        continue;
      }
      await fs.promises.rm(target, { recursive: true, force: true });
    }

    await appendJournalEntry(paths, {
      operationId,
      type: 'gc-completed',
      timestamp: new Date().toISOString(),
      details: { deleted: targets.deleted }
    });

    return {
      dryRun: false,
      deleted: targets.deleted,
      skipped: targets.skipped,
      message: `Deleted ${String(targets.deleted.length)} trash item(s)`
    };
  } finally {
    await lockHandle.release();
  }
}
