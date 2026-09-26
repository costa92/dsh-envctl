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
import { buildPlan, type EnvironmentPlan } from '../planner/plan.js';
import { loadManifest, loadLock, loadState, serializeState, serializeLock } from '../manifest/files.js';
import { acquireEnvironmentLock } from '../io/lock.js';
import { createEnvironmentSnapshot, restoreEnvironmentSnapshot, type EnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { writeAtomic } from '../io/atomic-file.js';
import { DshError, ValidationError, DegradedError, CapabilityError } from '../errors.js';
import { probeDsh, resolveDshCommand } from '../dsh/command.js';
import { capabilitiesFor } from '../dsh/capabilities.js';
import { setProfileBundleEnabled } from './bundles.js';
import { clearManagedPatches, writeManagedPatches } from './patches.js';

export interface ApplyOptions {
  dryRun?: boolean;
  allowUntested?: boolean;
  harnessSource?: string;
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
    case 'npm': {
      const version = lockedSource?.type === 'npm'
        ? lockedSource.resolvedVersion
        : plugin.source.version;
      return `${plugin.package}@${version}`;
    }
    case 'git': {
      const commit = lockedSource?.type === 'git' ? lockedSource.commit : plugin.source.commit;
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
      await setProfileBundleEnabled(
        paths,
        operation.profile,
        operation.package,
        operation.kind === 'enable'
      );
      continue;
    }

    if (operation.kind === 'configure') {
      const plugin = manifest.profiles[operation.profile]?.plugins[operation.alias];
      if (!plugin?.patches?.length) {
        throw new ValidationError(`No patches declared for ${operation.alias} in ${operation.profile}`);
      }
      await writeManagedPatches(paths, operation.profile, operation.alias, plugin.patches);
      continue;
    }

    if (operation.kind === 'remove') {
      await clearManagedPatches(paths, operation.profile, operation.alias);
      await setProfileBundleEnabled(paths, operation.profile, operation.package, false);
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
    next[operation.profile].plugins[operation.package] = {
      package: operation.package,
      status: 'restart-required',
      lastVerified: timestamp
    };
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

  const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
  const lock = fs.existsSync(paths.lockFile)
    ? loadLock(fs.readFileSync(paths.lockFile, 'utf8'))
    : null;
  const state = fs.existsSync(paths.stateFile)
    ? loadState(fs.readFileSync(paths.stateFile, 'utf8'))
    : null;

  const inventory = await readEnvironmentInventory(paths);
  const plan = buildPlan(manifest, lock, inventory, state);

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

  assertSupportedPlan(plan);

  const operationId = `apply-${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();

  let snapshot: EnvironmentSnapshot | null = null;

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
        unmanagedCount: plan.unmanaged.length
      }
    });

    // 3. Execute operations via executor (or the DSH CLI adapter)
    const execRes = options?.executor
      ? await options.executor(plan, paths)
      : await executeWithDsh(plan, paths, manifest, lock, inventory, options);
    if (!execRes.success) {
      throw new DegradedError(`Apply execution failed: ${execRes.error ?? 'Unknown executor error'}`);
    }

    // Never commit successful state until the actual environment converges.
    const verifiedInventory = await readEnvironmentInventory(paths);
    const remainingPlan = buildPlan(manifest, lock, verifiedInventory, state);
    if (remainingPlan.hasChanges) {
      throw new DegradedError('Apply execution finished but the environment still has pending operations');
    }

    // 4. Update state.json
    const lockSerialized = lock ? serializeLock(lock) : '{}';
    const lockHash = crypto.createHash('sha256').update(lockSerialized).digest('hex');

    const nextState: EnvironmentState = {
      apiVersion: 'dshenv-state/v1',
      lastApplied: now,
      appliedLockHash: lockHash,
      profiles: markRestartRequired(state?.profiles, plan, now),
      ownership: pruneOwnership(state?.ownership, manifest)
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
