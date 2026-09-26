import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { execa } from 'execa';
import type { EnvironmentPaths } from '../environment/paths.js';
import type {
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState
} from '../domain.js';
import { readEnvironmentInventory, type EnvironmentInventory } from '../inventory/profile-reader.js';
import { buildPlan, lockedGitCommit, type EnvironmentPlan, type LocalSourceDigests } from '../planner/plan.js';
import { loadLock, loadState, serializeState, serializeLock } from '../manifest/files.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import type { OverlaySelection } from '../overlay/selection.js';
import { acquireEnvironmentLock } from '../io/lock.js';
import { createEnvironmentSnapshot, restoreEnvironmentSnapshot, type EnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { writeAtomic } from '../io/atomic-file.js';
import { readLocalSourceDigests } from '../source/local.js';
import { DshError, ValidationError, DegradedError, CapabilityError } from '../errors.js';
import { probeDsh, resolveDshCommand } from '../dsh/command.js';
import { capabilitiesFor } from '../dsh/capabilities.js';
import { setProfileBundleEnabled } from './bundles.js';
import { clearManagedPatches, snapshotProfilePatchFile, writeManagedPatches } from './patches.js';

export interface ApplyOptions {
  dryRun?: boolean;
  allowUntested?: boolean;
  harnessSource?: string;
  overlay?: OverlaySelection | null;
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

interface ProfileRollback {
  // dshenv's own profile edits, undone in reverse order when apply fails.
  undo: Array<() => Promise<void>>;
  // Re-run after undo: edits that belong to a DSH change which cannot be reverted.
  keep: Array<() => Promise<void>>;
}

function packageSpec(
  manifest: EnvironmentManifest,
  lock: EnvironmentLock | null,
  operation: EnvironmentPlan['operations'][number]
): string {
  const plugin = manifest.profiles[operation.profile]?.plugins[operation.alias];
  if (!plugin) {
    throw new ValidationError(`Plugin '${operation.alias}' is missing from profile '${operation.profile}'`);
  }

  const lockedSource = lock?.profiles[operation.profile]?.plugins[operation.alias]?.source;
  switch (plugin.source.type) {
    case 'npm':
      return `${plugin.package}@${plugin.source.version}`;
    case 'git': {
      const commit = lockedGitCommit(plugin.source, lockedSource) ?? plugin.source.commit;
      if (!commit) throw new ValidationError(`Git plugin '${plugin.package}' has no locked commit`);
      return `${plugin.source.url}#${commit}`;
    }
    case 'local-link':
      return `link:${plugin.source.path}`;
    case 'local-file':
      return `file:${plugin.source.path}`;
    case 'in-box':
      return plugin.package;
  }
}

async function executeWithDsh(
  plan: EnvironmentPlan,
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  lock: EnvironmentLock | null,
  inventory: EnvironmentInventory,
  rollback: ProfileRollback,
  options?: ApplyOptions
): Promise<{ success: boolean; error?: string }> {
  assertSupportedPlan(plan);

  const needsCli = plan.operations.some((operation) => {
    if (operation.kind === 'install' || operation.kind === 'update') {
      return true;
    }
    if (operation.kind !== 'remove') {
      return false;
    }
    return inventory.profiles[operation.profile]?.plugins[operation.package]?.sourceType !== 'in-box';
  });
  const command = needsCli
    ? resolveDshCommand({
        cliHarnessSource: options?.harnessSource,
        manifestHarnessSource: manifest.environment?.harness?.sourceDir
      })
    : null;
  if (needsCli && !command) {
    throw new CapabilityError('DSH CLI was not found; configure DSH_CLI or --harness-source');
  }
  if (needsCli && command) {
    const probe = await probeDsh(command);
    const caps = capabilitiesFor(probe.version, { allowUntested: options?.allowUntested });
    if (caps.discovery.status !== 'available') {
      throw new CapabilityError('Unsupported DSH version');
    }
  }

  for (const operation of plan.operations) {
    if (operation.kind === 'enable' || operation.kind === 'disable') {
      const previousIndex = await setProfileBundleEnabled(
        paths,
        operation.profile,
        operation.package,
        operation.kind === 'enable'
      );
      rollback.undo.push(async () => {
        await setProfileBundleEnabled(paths, operation.profile, operation.package, previousIndex !== -1, previousIndex);
      });
      continue;
    }

    if (operation.kind === 'configure') {
      const plugin = manifest.profiles[operation.profile]?.plugins[operation.alias];
      if (!plugin) {
        throw new ValidationError(`Plugin '${operation.alias}' is missing from profile '${operation.profile}'`);
      }
      rollback.undo.push(await snapshotProfilePatchFile(paths, operation.profile));
      await writeManagedPatches(paths, operation.profile, operation.alias, plugin.patches ?? []);
      continue;
    }

    if (operation.kind === 'remove') {
      const undoStart = rollback.undo.length;
      rollback.undo.push(await snapshotProfilePatchFile(paths, operation.profile));
      await clearManagedPatches(paths, operation.profile, operation.alias);
      const previousIndex = await setProfileBundleEnabled(paths, operation.profile, operation.package, false);
      rollback.undo.push(async () => {
        await setProfileBundleEnabled(paths, operation.profile, operation.package, previousIndex !== -1, previousIndex);
      });
      const sourceType = inventory.profiles[operation.profile]?.plugins[operation.package]?.sourceType;
      if (sourceType === 'in-box') {
        continue;
      }
      if (!command) {
        throw new CapabilityError('DSH CLI was not found; configure DSH_CLI or --harness-source');
      }
      const removeResult = await execa(
        command.file,
        [...command.args, 'plugin', '--profile', operation.profile, 'remove', operation.package],
        {
          cwd: command.cwd,
          env: { ...process.env, DSH_HOME: paths.home },
          shell: false,
          reject: false
        }
      );
      if (removeResult.exitCode !== 0) {
        return { success: false, error: `DSH plugin command exited with code ${String(removeResult.exitCode)}` };
      }
      // The package is gone; restoring its bundle or patch would describe a plugin that no longer exists.
      rollback.undo.length = undoStart;
      rollback.keep.push(() => clearManagedPatches(paths, operation.profile, operation.alias));
      continue;
    }

    if (!command) {
      throw new CapabilityError('DSH CLI was not found; configure DSH_CLI or --harness-source');
    }

    const result = await execa(
      command.file,
      [...command.args, 'plugin', '--profile', operation.profile, 'add', packageSpec(manifest, lock, operation)],
      {
        cwd: command.cwd,
        env: { ...process.env, DSH_HOME: paths.home },
        shell: false,
        reject: false
      }
    );
    if (result.exitCode !== 0) {
      return { success: false, error: `DSH plugin command exited with code ${String(result.exitCode)}` };
    }
  }

  return { success: true };
}

function markRestartRequired(
  profiles: EnvironmentState['profiles'] | undefined,
  plan: EnvironmentPlan,
  verifiedInventory: EnvironmentInventory,
  timestamp: string
): EnvironmentState['profiles'] {
  const next: EnvironmentState['profiles'] = {};
  for (const [profileName, profile] of Object.entries(profiles ?? {})) {
    next[profileName] = { plugins: { ...profile.plugins } };
  }
  for (const operation of plan.operations) {
    if (
      operation.kind !== 'install' &&
      operation.kind !== 'update' &&
      operation.kind !== 'enable' &&
      operation.kind !== 'disable' &&
      operation.kind !== 'remove'
    ) {
      continue;
    }
    if (!next[operation.profile]) {
      next[operation.profile] = { plugins: {} };
    }
    const installedVersion = verifiedInventory.profiles[operation.profile]?.plugins[operation.package]?.version;
    next[operation.profile].plugins[operation.package] = {
      package: operation.package,
      status: 'restart-required',
      ...(installedVersion ? { installedVersion } : {}),
      lastVerified: timestamp
    };
  }
  return next;
}

// Record the source digest each local plugin was installed from, so plan can detect later edits.
function recordLocalDigests(
  lock: EnvironmentLock | null,
  manifest: EnvironmentManifest,
  digests: LocalSourceDigests
): EnvironmentLock | null {
  let next = lock;
  for (const [profileName, aliases] of Object.entries(digests)) {
    for (const [alias, digest] of Object.entries(aliases)) {
      const plugin = manifest.profiles[profileName]?.plugins[alias];
      if (!plugin || (plugin.source.type !== 'local-file' && plugin.source.type !== 'local-link')) {
        continue;
      }
      const entry = { package: plugin.package, source: { type: plugin.source.type, path: plugin.source.path, digest } };
      if (JSON.stringify(next?.profiles[profileName]?.plugins[alias]) === JSON.stringify(entry)) {
        continue;
      }
      next = structuredClone(next ?? { apiVersion: 'dshenv-lock/v1', profiles: {} });
      (next.profiles[profileName] ??= { plugins: {} }).plugins[alias] = entry;
    }
  }
  return next;
}

function pruneOwnership(
  ownership: EnvironmentState['ownership'],
  manifest: EnvironmentManifest
): EnvironmentState['ownership'] {
  if (!ownership) {
    return {};
  }

  const next: NonNullable<EnvironmentState['ownership']> = {};
  for (const [profileName, packages] of Object.entries(ownership)) {
    const expected = new Set(
      Object.values(manifest.profiles[profileName]?.plugins ?? {}).map((plugin) => plugin.package)
    );
    const kept: Record<string, (typeof packages)[string]> = {};
    for (const [packageName, record] of Object.entries(packages)) {
      if (expected.has(packageName)) {
        kept[packageName] = record;
      }
    }
    if (Object.keys(kept).length > 0) {
      next[profileName] = kept;
    }
  }
  return next;
}

function assertSupportedPlan(plan: EnvironmentPlan): void {
  const blocked = plan.operations.find((operation) => operation.kind === 'blocked');
  if (blocked) {
    throw new DegradedError(
      `Apply is blocked: ${blocked.blockedReason ?? blocked.reason}`
    );
  }

  const unsupported = plan.operations.find(
    (operation) =>
      operation.kind !== 'install' &&
      operation.kind !== 'update' &&
      operation.kind !== 'enable' &&
      operation.kind !== 'disable' &&
      operation.kind !== 'remove' &&
      operation.kind !== 'configure'
  );
  if (unsupported) {
    throw new CapabilityError(
      `Apply operation '${unsupported.kind}' is not supported by the DSH CLI adapter`
    );
  }
}

export async function applyEnvironment(
  paths: EnvironmentPaths,
  options?: ApplyOptions
): Promise<ApplyResult> {
  if (!fs.existsSync(paths.manifestFile)) {
    throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
  }

  if (options?.dryRun) {
    return planAndApply(paths, options);
  }
  // Plan only after locking so rollback/purge cannot change the files between plan and execution.
  const lockHandle = await acquireEnvironmentLock(paths);
  try {
    return await planAndApply(paths, options);
  } finally {
    await lockHandle.release();
  }
}

async function planAndApply(
  paths: EnvironmentPaths,
  options?: ApplyOptions
): Promise<ApplyResult> {
  if (!fs.existsSync(paths.manifestFile)) {
    throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
  }

  // Loaded after the environment lock is held (see applyEnvironment), so the overlay cannot change mid-apply.
  const { manifest } = loadEffectiveManifest(paths, options?.overlay ?? null);
  const lock = fs.existsSync(paths.lockFile)
    ? loadLock(fs.readFileSync(paths.lockFile, 'utf8'))
    : null;
  const state = fs.existsSync(paths.stateFile)
    ? loadState(fs.readFileSync(paths.stateFile, 'utf8'))
    : null;

  const inventory = await readEnvironmentInventory(paths);
  const localDigests = await readLocalSourceDigests(manifest);
  const plan = buildPlan(manifest, lock, inventory, state, localDigests);

  if (!plan.hasChanges) {
    // Record the overlay even without operations, otherwise the switch warning never clears.
    if (!options?.dryRun && state && state.appliedOverlay !== options?.overlay?.name) {
      const { appliedOverlay: _previous, ...rest } = state;
      const nextState: EnvironmentState = options?.overlay ? { ...rest, appliedOverlay: options.overlay.name } : rest;
      await writeAtomic(paths.stateFile, serializeState(nextState), 'overwrite');
    }
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

  assertSupportedPlan(plan);

  const operationId = `apply-${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();

  let snapshot: EnvironmentSnapshot | null = null;
  const rollback: ProfileRollback = { undo: [], keep: [] };

  try {
    // 1. Create snapshot before any modifications
    snapshot = await createEnvironmentSnapshot(paths, operationId);

    // 2. Log operation start
    await appendJournalEntry(paths, {
      operationId,
      type: 'apply-started',
      timestamp: now,
      details: {
        operationCount: plan.operations.length,
        unmanagedCount: plan.unmanaged.length,
        overlay: options?.overlay?.name ?? null
      }
    });

    // 3. Execute operations via executor (or the DSH CLI adapter)
    const execRes = options?.executor
      ? await options.executor(plan, paths)
      : await executeWithDsh(plan, paths, manifest, lock, inventory, rollback, options);
    if (!execRes.success) {
      throw new DegradedError(`Apply execution failed: ${execRes.error ?? 'Unknown executor error'}`);
    }

    // Never commit successful state until the actual environment converges.
    const nextLock = recordLocalDigests(lock, manifest, localDigests);
    const verifiedInventory = await readEnvironmentInventory(paths);
    const remainingPlan = buildPlan(manifest, nextLock, verifiedInventory, state, localDigests);
    if (remainingPlan.hasChanges) {
      throw new DegradedError('Apply execution finished but the environment still has pending operations');
    }
    if (nextLock !== lock && nextLock) {
      await writeAtomic(paths.lockFile, serializeLock(nextLock), 'overwrite');
    }

    // 4. Update state.json
    const lockSerialized = nextLock ? serializeLock(nextLock) : '{}';
    const lockHash = crypto.createHash('sha256').update(lockSerialized).digest('hex');

    const nextState: EnvironmentState = {
      apiVersion: 'dshenv-state/v1',
      lastApplied: now,
      appliedLockHash: lockHash,
      profiles: markRestartRequired(state?.profiles, plan, verifiedInventory, now),
      ownership: pruneOwnership(state?.ownership, manifest),
      ...(options?.overlay ? { appliedOverlay: options.overlay.name } : {})
    };

    await writeAtomic(paths.stateFile, serializeState(nextState), 'overwrite');

    // 5. Log operation completion
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
    for (const step of [...[...rollback.undo].reverse(), ...rollback.keep]) {
      try {
        await step();
      } catch {
        // keep undoing the remaining edits; preserve original error
      }
    }

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
  }
}
