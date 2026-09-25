import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { EnvironmentPaths } from '../environment/paths.js';
import type {
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState
} from '../domain.js';
import { readEnvironmentInventory, type EnvironmentInventory } from '../inventory/profile-reader.js';
import { buildPlan, type EnvironmentPlan } from '../planner/plan.js';
import { loadManifest, loadLock, loadState, serializeState, serializeLock } from '../manifest/files.js';
import { acquireEnvironmentLock, type LockHandle } from '../io/lock.js';
import { createEnvironmentSnapshot, restoreEnvironmentSnapshot, type EnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { writeAtomic } from '../io/atomic-file.js';
import { DshError, ValidationError, DegradedError, CapabilityError } from '../errors.js';

export interface ApplyOptions {
  dryRun?: boolean;
  allowUntested?: boolean;
  executor?: (plan: EnvironmentPlan, paths: EnvironmentPaths) => Promise<{ success: boolean; error?: string }>;
}

export interface ApplyResult {
  applied: boolean;
  dryRun: boolean;
  operationId?: string;
  plan: EnvironmentPlan;
  message?: string;
  snapshotId?: string;
}

export async function applyEnvironment(
  paths: EnvironmentPaths,
  options?: ApplyOptions
): Promise<ApplyResult> {
  if (!fs.existsSync(paths.manifestFile)) {
    throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
  }

  const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
  const lock = fs.existsSync(paths.lockFile)
    ? loadLock(fs.readFileSync(paths.lockFile, 'utf8'))
    : null;
  const state = fs.existsSync(paths.stateFile)
    ? loadState(fs.readFileSync(paths.stateFile, 'utf8'))
    : null;

  const inventory = await readEnvironmentInventory(paths);
  const plan = buildPlan(manifest, lock, inventory);

  if (!plan.hasChanges) {
    return {
      applied: false,
      dryRun: Boolean(options?.dryRun),
      plan,
      message: 'Environment is in sync with manifest. No operations needed.'
    };
  }

  if (options?.dryRun) {
    return {
      applied: false,
      dryRun: true,
      plan,
      message: 'Dry run completed. Planned operations ready.'
    };
  }

  const operationId = `apply-${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();

  let lockHandle: LockHandle | null = null;
  let snapshot: EnvironmentSnapshot | null = null;

  try {
    // 1. Acquire environment lock
    lockHandle = await acquireEnvironmentLock(paths);

    // 2. Create snapshot before any modifications
    snapshot = await createEnvironmentSnapshot(paths, operationId);

    // 3. Log operation start
    await appendJournalEntry(paths, {
      operationId,
      type: 'apply-started',
      timestamp: now,
      details: {
        operationCount: plan.operations.length,
        unmanagedCount: plan.unmanaged.length
      }
    });

    // 4. Execute operations via executor (or default executor)
    if (options?.executor) {
      const execRes = await options.executor(plan, paths);
      if (!execRes.success) {
        throw new DegradedError(`Apply execution failed: ${execRes.error ?? 'Unknown executor error'}`);
      }
    }

    // 5. Update state.json
    const lockSerialized = lock ? serializeLock(lock) : '{}';
    const lockHash = crypto.createHash('sha256').update(lockSerialized).digest('hex');

    const nextState: EnvironmentState = {
      apiVersion: 'dshenv-state/v1',
      lastApplied: now,
      appliedLockHash: lockHash,
      profiles: state?.profiles ?? {},
      ownership: state?.ownership ?? {}
    };

    await writeAtomic(paths.stateFile, serializeState(nextState), 'overwrite');

    // 6. Log operation completion
    await appendJournalEntry(paths, {
      operationId,
      type: 'apply-completed',
      timestamp: new Date().toISOString(),
      details: {
        appliedOperations: plan.operations.length
      }
    });

    return {
      applied: true,
      dryRun: false,
      operationId,
      snapshotId: snapshot.snapshotId,
      plan,
      message: `Successfully applied ${plan.operations.length} operation(s).`
    };
  } catch (err: unknown) {
    // Rollback if snapshot was created
    if (snapshot) {
      try {
        await restoreEnvironmentSnapshot(snapshot, paths);
        await appendJournalEntry(paths, {
          operationId,
          type: 'apply-rollback',
          timestamp: new Date().toISOString(),
          details: {
            reason: err instanceof Error ? err.message : String(err)
          }
        });
      } catch {
        // preserve original error
      }
    }

    if (err instanceof DshError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new DegradedError(`Apply failed: ${message}`);
  } finally {
    if (lockHandle) {
      await lockHandle.release();
    }
  }
}
