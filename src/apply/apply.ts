import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { execa } from 'execa';
import type { EnvironmentPaths } from '../environment/paths.js';
import type {
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState
} from '../domain.js';
import { readEnvironmentInventory, type EnvironmentInventory } from '../inventory/profile-reader.js';
import { buildPlan, lockedGitCommit, type EnvironmentPlan, type LocalSourceDigests, type PlanOperation } from '../planner/plan.js';
import { loadLock, loadState, serializeState, serializeLock } from '../manifest/files.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import type { OverlaySelection } from '../overlay/selection.js';
import { acquireEnvironmentLock } from '../io/lock.js';
import { stopOnInterrupt } from '../io/interrupt.js';
import { createEnvironmentSnapshot, restoreSnapshotFiles, type EnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { lastSuccessfulApply } from '../rollback/rollback.js';
import { writeAtomic } from '../io/atomic-file.js';
import { awaitWithTreeTimeout } from '../io/process-tree.js';
import { releaseProfileLockOfStopped } from '../io/profile-lock.js';
import { readLocalSourceDigests } from '../source/local.js';
import { DshError, ValidationError, DegradedError, CapabilityError, missingManifestError } from '../errors.js';
import { probeDsh, resolveDshCommand, type CommandSpec } from '../dsh/command.js';
import { unsupportedDshVersionMessage } from '../dsh/version.js';
import { capabilitiesFor } from '../dsh/capabilities.js';
import { probeProfileHmr, type HmrStatus } from '../dsh/hmr.js';
import { readRemoteConfig } from '../remote/schema.js';
import { lockEntryId } from '../remote/lock-entries.js';
import { setProfileBundleEnabled } from './bundles.js';
import { clearManagedPatches, writeManagedPatches, writePluginMount, writeProfilePatches } from './patches.js';
import { isBundlePackage } from '../patch/mount.js';
import { PROFILE_PATCHES_ALIAS } from '../profile-patches/entries.js';
import { applySkillOperation } from '../skills/skills.js';
import { buildRestartSummary, profilesToProbe, type RestartSummary } from './restart-plan.js';

// Longer than the ~2 s awaitWriteFinish window of DSH's HMR watcher, so it unloads the plugin before its files go.
export const HMR_SETTLE_MS = 3000;
// A hung package install would otherwise hold the environment lock forever.
export const DSH_COMMAND_TIMEOUT_MS = 10 * 60_000;

export interface ApplyOptions {
  dryRun?: boolean;
  allowUntested?: boolean;
  harnessSource?: string;
  overlay?: OverlaySelection | null;
  executor?: (plan: EnvironmentPlan, paths: EnvironmentPaths) => Promise<{ success: boolean; error?: string }>;
  probeHmr?: (profile: string) => Promise<HmrStatus>;
  hmrSettleMs?: number;
  dshCommandTimeoutMs?: number;
}

export interface ApplyResult {
  applied: boolean;
  dryRun: boolean;
  operationId?: string;
  plan: EnvironmentPlan;
  message?: string;
  snapshotId?: string;
  restart?: RestartSummary;
}

// Only DSH's own `dsh:` lines are shown: the raw pnpm output around them can echo registry URLs and tokens.
function dshFailure(result: { exitCode?: number; timedOut?: boolean; stdout?: unknown; stderr?: unknown }, timeoutMs: number): string {
  const diagnostics = [result.stderr, result.stdout]
    .flatMap((output) => (typeof output === 'string' ? output.split('\n') : []))
    .filter((line) => line.startsWith('dsh: '))
    .map((line) => `\n  ${line.trimEnd()}`)
    .join('');
  const outcome = result.timedOut ? `timed out after ${timeoutMs} ms` : `exited with code ${String(result.exitCode)}`;
  return `DSH plugin command ${outcome}${diagnostics}`;
}

async function runDshPluginCommand(
  command: CommandSpec,
  profile: string,
  args: string[],
  paths: EnvironmentPaths,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ exitCode?: number; timedOut: boolean; stdout?: unknown; stderr?: unknown }> {
  const subprocess = execa(command.file, [...command.args, 'plugin', '--profile', profile, ...args], {
    cwd: command.cwd,
    env: { ...process.env, DSH_HOME: paths.home },
    shell: false,
    reject: false
  });
  const { result, timedOut, killed } = await awaitWithTreeTimeout(subprocess, timeoutMs, signal);
  if (killed.length > 0) {
    await releaseProfileLockOfStopped(path.join(paths.profilesDir, profile, 'package.json'), killed);
  }
  return { exitCode: result.exitCode, timedOut, stdout: result.stdout, stderr: result.stderr };
}

// Stops apply between steps once dshenv is interrupted, so the failure path rolls back what it did so far.
function assertNotInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DegradedError('Apply was interrupted');
  }
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
      // pnpm reads a bare file:// or non-hosted https:// URL as a local path or tarball, not a Git repository.
      const url = /^(?:https?|ssh|file):\/\//i.test(plugin.source.url) ? `git+${plugin.source.url}` : plugin.source.url;
      return `${url}#${commit}`;
    }
    case 'local-link':
      return `link:${plugin.source.path}`;
    case 'local-file':
      return `file:${plugin.source.path}`;
    case 'in-box':
      return plugin.package;
  }
}

function planNeedsDshCli(plan: EnvironmentPlan, inventory: EnvironmentInventory): boolean {
  return plan.operations.some((operation) => {
    if (operation.kind === 'install' || operation.kind === 'update') {
      return true;
    }
    if (operation.kind !== 'remove') {
      return false;
    }
    return inventory.profiles[operation.profile]?.plugins[operation.package]?.sourceType !== 'in-box';
  });
}

function dshCommandFor(manifest: EnvironmentManifest, options?: ApplyOptions): CommandSpec | null {
  return resolveDshCommand({
    cliHarnessSource: options?.harnessSource,
    manifestHarnessSource: manifest.environment?.harness?.sourceDir
  });
}

async function assertSupportedDsh(
  command: CommandSpec,
  manifest: EnvironmentManifest,
  options?: ApplyOptions,
  { tolerateProbeFailure = false } = {}
): Promise<void> {
  let probe: Awaited<ReturnType<typeof probeDsh>>;
  try {
    probe = await probeDsh(command);
  } catch (err) {
    if (tolerateProbeFailure) {
      return;
    }
    throw err;
  }
  const caps = capabilitiesFor(probe.version, {
    allowUntested: options?.allowUntested || manifest.environment?.harness?.allowUntestedVersion
  });
  if (caps.discovery.status !== 'available') {
    throw new CapabilityError(unsupportedDshVersionMessage(probe.version));
  }
}

async function executeWithDsh(
  plan: EnvironmentPlan,
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  lock: EnvironmentLock | null,
  inventory: EnvironmentInventory,
  rollback: ProfileRollback,
  hmrByProfile: ReadonlyMap<string, HmrStatus>,
  onInstalled: (operation: PlanOperation) => Promise<void>,
  signal: AbortSignal | undefined,
  command: CommandSpec | null,
  options?: ApplyOptions
): Promise<{ success: boolean; error?: string; failedAt?: string }> {
  assertSupportedPlan(plan);

  const commandTimeoutMs = options?.dshCommandTimeoutMs ?? DSH_COMMAND_TIMEOUT_MS;
  // A plugin that is not a DSH bundle is switched by its insert row; it never belongs in the bundle list.
  const setPlainPluginEnabled = async (operation: PlanOperation, enabled: boolean): Promise<void> => {
    rollback.undo.push(await writePluginMount(paths, operation.profile, operation.alias, enabled ? operation.package : null));
    const previousIndex = await setProfileBundleEnabled(paths, operation.profile, operation.package, false);
    rollback.undo.push(async () => {
      await setProfileBundleEnabled(paths, operation.profile, operation.package, previousIndex !== -1, previousIndex);
    });
  };
  for (const [index, operation] of plan.operations.entries()) {
    assertNotInterrupted(signal);
    const failedAt = `[${operation.profile}] ${operation.kind} ${operation.alias} (${operation.package}), step ${index + 1} of ${plan.operations.length}`;
    if ((operation.kind === 'enable' || operation.kind === 'disable') && inventory.profiles[operation.profile]?.plugins[operation.package]?.bundle === false) {
      await setPlainPluginEnabled(operation, operation.kind === 'enable');
      continue;
    }
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

    if (operation.kind === 'configure' && operation.alias === PROFILE_PATCHES_ALIAS) {
      rollback.undo.push(await writeProfilePatches(paths, operation.profile, manifest.profiles[operation.profile]?.patches ?? []));
      continue;
    }

    if (operation.kind === 'configure') {
      const plugin = manifest.profiles[operation.profile]?.plugins[operation.alias];
      if (!plugin) {
        throw new ValidationError(`Plugin '${operation.alias}' is missing from profile '${operation.profile}'`);
      }
      rollback.undo.push(await writeManagedPatches(paths, operation.profile, operation.alias, plugin.patches ?? []));
      continue;
    }

    if (operation.kind === 'remove') {
      const undoStart = rollback.undo.length;
      // The alias may now name the package replacing this one (removes run first); its patches belong to that entry.
      const aliasRedeclared = Boolean(manifest.profiles[operation.profile]?.plugins[operation.alias]);
      if (!aliasRedeclared) {
        rollback.undo.push(await clearManagedPatches(paths, operation.profile, operation.alias));
      }
      rollback.undo.push(await writePluginMount(paths, operation.profile, operation.alias, null));
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
      // Only a plugin that was in the bundle list or mounted is loaded, so only then is there an unload to wait for.
      const installed = inventory.profiles[operation.profile]?.plugins[operation.package];
      const wasMounted = installed?.bundle === false && installed.enabled === true;
      if ((previousIndex !== -1 || wasMounted) && hmrByProfile.get(operation.profile)?.state === 'on') {
        await delay(options?.hmrSettleMs ?? HMR_SETTLE_MS, undefined, { signal }).catch(() => assertNotInterrupted(signal));
      }
      const removeResult = await runDshPluginCommand(
        command,
        operation.profile,
        ['remove', operation.package],
        paths,
        commandTimeoutMs,
        signal
      );
      if (removeResult.exitCode !== 0) {
        assertNotInterrupted(signal);
        return { success: false, error: dshFailure(removeResult, commandTimeoutMs), failedAt };
      }
      // The package is gone; restoring its bundle or patch would describe a plugin that no longer exists.
      rollback.undo.length = undoStart;
      rollback.keep.push(async () => {
        if (!aliasRedeclared) {
          await clearManagedPatches(paths, operation.profile, operation.alias);
        }
        await writePluginMount(paths, operation.profile, operation.alias, null);
      });
      continue;
    }

    if (!command) {
      throw new CapabilityError('DSH CLI was not found; configure DSH_CLI or --harness-source');
    }

    const result = await runDshPluginCommand(
      command,
      operation.profile,
      ['add', packageSpec(manifest, lock, operation)],
      paths,
      commandTimeoutMs,
      signal
    );
    if (result.exitCode !== 0) {
      // Killed because of the interrupt: report that, not the exit code it caused.
      assertNotInterrupted(signal);
      return { success: false, error: dshFailure(result, commandTimeoutMs), failedAt };
    }
    if (operation.kind === 'install') {
      await onInstalled(operation);
    }
    // Only now is the package on disk to tell whether DSH loads it as a bundle.
    if (installedAsPlainPlugin(paths, operation.profile, operation.package)) {
      await setPlainPluginEnabled(operation, operation.targetEnabled !== false);
    }
  }

  return { success: true };
}

function installedAsPlainPlugin(paths: EnvironmentPaths, profile: string, packageName: string): boolean {
  try {
    const file = path.join(paths.profilesDir, profile, 'node_modules', ...packageName.split('/'), 'package.json');
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) && !isBundlePackage(raw as Record<string, unknown>);
  } catch {
    return false;
  }
}

function recordRestartState(
  profiles: EnvironmentState['profiles'] | undefined,
  plan: EnvironmentPlan,
  verifiedInventory: EnvironmentInventory,
  timestamp: string,
  restart: RestartSummary
): EnvironmentState['profiles'] {
  const next: EnvironmentState['profiles'] = {};
  for (const [profileName, profile] of Object.entries(profiles ?? {})) {
    next[profileName] = { plugins: { ...profile.plugins } };
  }
  const restartRequired = new Set(restart.required.map((item) => `${item.profile}\0${item.package}`));
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
    const plugins = next[operation.profile].plugins;
    const needsRestart = restartRequired.has(`${operation.profile}\0${operation.package}`);
    if (!needsRestart && operation.kind === 'remove') {
      delete plugins[operation.package];
      continue;
    }
    // A hot-reloaded change must not clear a restart an earlier apply still owes.
    const pending = plugins[operation.package]?.status === 'restart-required';
    const installedVersion = verifiedInventory.profiles[operation.profile]?.plugins[operation.package]?.version;
    plugins[operation.package] = {
      package: operation.package,
      status: needsRestart || pending ? 'restart-required' : 'healthy',
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

// A local entry written over a team entry would be reported as a local change by every later sync.
function assertNoTeamEntryOverwritten(
  paths: EnvironmentPaths,
  lock: EnvironmentLock | null,
  nextLock: EnvironmentLock | null
): void {
  if (!nextLock || nextLock === lock) {
    return;
  }
  const config = readRemoteConfig(paths);
  if (!config) {
    return;
  }
  for (const [profileName, { plugins }] of Object.entries(nextLock.profiles)) {
    for (const [alias, entry] of Object.entries(plugins)) {
      if (!config.lockEntries[profileName]?.[alias]) {
        continue;
      }
      if (JSON.stringify(lock?.profiles[profileName]?.plugins[alias]) === JSON.stringify(entry)) {
        continue;
      }
      throw new ValidationError(
        `Lock entry '${lockEntryId(profileName, alias)}' is pinned by the team lock of remote ${config.url}; ` +
          'a local overlay cannot switch it to a local source. ' +
          'Disable it with remove: true in the overlay and add the local plugin under a new alias'
      );
    }
  }
}

// A plugin apply installed is dshenv's to remove once the manifest drops it, as if it had been adopted.
function recordInstalledOwnership(
  pruned: EnvironmentState['ownership'],
  operations: PlanOperation[],
  manifest: EnvironmentManifest,
  now: string,
  operationId: string
): EnvironmentState['ownership'] {
  const ownership = { ...pruned };
  for (const operation of operations) {
    const plugin = manifest.profiles[operation.profile]?.plugins[operation.alias];
    if (operation.kind !== 'install' || !plugin || ownership[operation.profile]?.[plugin.package]) {
      continue;
    }
    ownership[operation.profile] = {
      ...ownership[operation.profile],
      [plugin.package]: {
        package: plugin.package,
        alias: operation.alias,
        sourceType: plugin.source.type,
        lockedVersion: plugin.source.type === 'npm' ? plugin.source.version : undefined,
        adoptedAt: now,
        adoptedBy: operationId
      }
    };
  }
  return ownership;
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

function defaultHmrProbe(
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  options?: ApplyOptions
): (profile: string) => Promise<HmrStatus> {
  const command = resolveDshCommand({
    cliHarnessSource: options?.harnessSource,
    manifestHarnessSource: manifest.environment?.harness?.sourceDir
  });
  return async (profile) => {
    // dsh --dump-config creates a missing profile, which a dry run must not do.
    if (!fs.existsSync(path.join(paths.profilesDir, profile, 'package.json'))) {
      return { state: 'unknown', reason: `profile ${profile} does not exist yet` };
    }
    return probeProfileHmr(profile, { command, dshHome: paths.home });
  };
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

// What a failed step left behind and the way back, since the manifest keeps declaring the change that failed.
async function recoveryHint(paths: EnvironmentPaths, operationId: string, installed: PlanOperation[]): Promise<string> {
  const kept = installed.length > 0 ? `; plugins it installed before failing stay installed: ${installed.map((op) => op.alias).join(', ')}` : '';
  const lines = [`Apply ${operationId} put lock.json and state.json back${kept}.`];
  // Only a pointer onward; a lookup failure must not read as a failed restore.
  const previous = await lastSuccessfulApply(paths).catch(() => null);
  lines.push(
    previous
      ? `The manifest still declares what failed: fix it and apply again, or go back to the manifest apply ${previous} applied (dropping every manifest change made since) with: dshenv rollback ${previous} --yes`
      : 'The manifest still declares what failed: fix it and apply again.'
  );
  return `\n${lines.join('\n')}`;
}

export async function applyEnvironment(
  paths: EnvironmentPaths,
  options?: ApplyOptions
): Promise<ApplyResult> {
  if (!fs.existsSync(paths.manifestFile)) {
    throw missingManifestError(paths.manifestFile);
  }

  if (options?.dryRun) {
    return planAndApply(paths, options);
  }
  // Plan only after locking so rollback/purge cannot change the files between plan and execution.
  const lockHandle = await acquireEnvironmentLock(paths);
  // On Ctrl-C, apply stops DSH and rolls back through its failure path; the interrupt waits for that and the lock release.
  const interrupt = new AbortController();
  let settled!: () => void;
  const done = new Promise<void>((resolve) => (settled = resolve));
  const dispose = stopOnInterrupt(async () => {
    interrupt.abort();
    await done;
  });
  let outcome: { result: ApplyResult } | { error: unknown };
  try {
    outcome = { result: await planAndApply(paths, options, interrupt.signal) };
  } catch (error) {
    outcome = { error };
  } finally {
    await lockHandle.release();
    dispose();
    settled();
  }
  if (interrupt.signal.aborted) {
    // The signal ends dshenv once the cleanup above returns; reporting the rollback as a failure would only race it.
    await new Promise(() => {});
  }
  if ('error' in outcome) {
    throw outcome.error;
  }
  return outcome.result;
}

async function planAndApply(
  paths: EnvironmentPaths,
  options?: ApplyOptions,
  signal?: AbortSignal
): Promise<ApplyResult> {
  if (!fs.existsSync(paths.manifestFile)) {
    throw missingManifestError(paths.manifestFile);
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
    // Record the overlay and skill baselines even without operations, otherwise the switch warning never clears
    // and a declared skill DSH already had is never owned.
    const skills = inventory.skills?.declared ?? {};
    if (
      !options?.dryRun &&
      state &&
      (state.appliedOverlay !== options?.overlay?.name || !isDeepStrictEqual(state.skills ?? {}, skills))
    ) {
      const { appliedOverlay: _previous, skills: _skills, ...rest } = state;
      const nextState: EnvironmentState = {
        ...rest,
        ...(options?.overlay ? { appliedOverlay: options.overlay.name } : {}),
        ...(Object.keys(skills).length > 0 ? { skills } : {})
      };
      await writeAtomic(paths.stateFile, serializeState(nextState), 'overwrite');
    }
    return {
      applied: false,
      dryRun: Boolean(options?.dryRun),
      plan,
      message: 'Environment is in sync with manifest. No operations needed.'
    };
  }

  // Checked before the dry-run return too, so a preview reports the refusal a real apply would hit.
  assertNoTeamEntryOverwritten(paths, lock, recordLocalDigests(lock, manifest, localDigests));

  // A real apply refuses a blocked plan before spending up to a probe timeout per profile; a dry run still previews it.
  if (!options?.dryRun) {
    assertSupportedPlan(plan);
  }

  const probe = options?.probeHmr ?? defaultHmrProbe(paths, manifest, options);
  const profiles = profilesToProbe(plan);
  const statuses = await Promise.all(profiles.map((profile) => probe(profile)));
  const hmrByProfile = new Map<string, HmrStatus>(profiles.map((profile, index) => [profile, statuses[index]]));
  const restart = buildRestartSummary(plan, hmrByProfile);

  if (options?.dryRun) {
    // A preview refuses an unsupported DSH like the real apply would; a DSH it cannot ask still gets the plan shown.
    const command = planNeedsDshCli(plan, inventory) && !options.executor ? dshCommandFor(manifest, options) : null;
    if (command) {
      await assertSupportedDsh(command, manifest, options, { tolerateProbeFailure: true });
    }
    return {
      applied: false,
      dryRun: true,
      plan,
      message: 'Dry run completed. Planned operations ready.',
      restart
    };
  }

  // Checked before the snapshot and journal entry, so a refused DSH leaves nothing for rollback to pick.
  const needsCli = !options?.executor && planNeedsDshCli(plan, inventory);
  const command = needsCli ? dshCommandFor(manifest, options) : null;
  if (needsCli && !command) {
    throw new CapabilityError('DSH CLI was not found; configure DSH_CLI or --harness-source');
  }
  if (command) {
    await assertSupportedDsh(command, manifest, options);
  }

  const operationId = `apply-${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();

  let snapshot: EnvironmentSnapshot | null = null;
  // Set when a plan step failed, as opposed to a check before or after the steps.
  let failedStep = false;
  const rollback: ProfileRollback = { undo: [], keep: [] };
  // DSH cannot take an install back, so each one is owned as soon as it succeeds, even if apply then fails or is killed.
  const installed: PlanOperation[] = [];
  const recordInstalled = async (): Promise<void> => {
    const base: EnvironmentState = state ?? { apiVersion: 'dshenv-state/v1', lastApplied: '', appliedLockHash: '', profiles: {} };
    const ownership = recordInstalledOwnership(base.ownership, installed, manifest, now, operationId);
    await writeAtomic(paths.stateFile, serializeState({ ...base, ownership }), 'overwrite');
  };
  const onInstalled = async (operation: PlanOperation): Promise<void> => {
    installed.push(operation);
    await recordInstalled();
  };

  try {
    // 1. Create snapshot before any modifications
    // The active overlay is part of what this apply applies, so rolling back to this snapshot must restore it too.
    snapshot = await createEnvironmentSnapshot(paths, operationId, {
      overlayKeys: options?.overlay ? [`overlays/${options.overlay.name}.yaml`] : []
    });

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
      : await executeWithDsh(plan, paths, manifest, lock, inventory, rollback, hmrByProfile, onInstalled, signal, command, options);
    if (!execRes.success) {
      failedStep = true;
      const at = 'failedAt' in execRes && execRes.failedAt ? ` at ${execRes.failedAt}` : '';
      throw new DegradedError(`Apply execution failed${at}: ${execRes.error ?? 'Unknown executor error'}`);
    }
    // Replaced and removed skills go to trash rather than away, since DSH may hold edits nobody pulled.
    assertNotInterrupted(signal);
    const trashRoot = path.join(paths.trashDir, operationId);
    for (const operation of plan.skillOperations) {
      rollback.undo.push(await applySkillOperation(paths, operation, trashRoot));
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
      profiles: recordRestartState(state?.profiles, plan, verifiedInventory, now, restart),
      ownership: recordInstalledOwnership(pruneOwnership(state?.ownership, manifest), plan.operations, manifest, now, operationId),
      ...(options?.overlay ? { appliedOverlay: options.overlay.name } : {}),
      // Converged, so every declared skill is in DSH exactly as declared.
      ...(Object.keys(verifiedInventory.skills?.declared ?? {}).length > 0 ? { skills: verifiedInventory.skills!.declared } : {})
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
      message: `Successfully applied ${plan.operations.length} operation(s).`,
      restart
    };
  } catch (err: unknown) {
    for (const step of [...[...rollback.undo].reverse(), ...rollback.keep]) {
      try {
        await step();
      } catch {
        // keep undoing the remaining edits; preserve original error
      }
    }

    // Apply writes only lock.json and state.json; the manifest and envctl/skills may hold edits made meanwhile.
    let failureNote = '';
    if (snapshot) {
      try {
        await restoreSnapshotFiles(snapshot, [paths.lockFile, paths.stateFile]);
        if (installed.length > 0) {
          await recordInstalled();
        }
        await appendJournalEntry(paths, {
          operationId,
          type: 'apply-rollback',
          timestamp: new Date().toISOString(),
          details: {
            reason: err instanceof Error ? err.message : String(err)
          }
        });
      } catch (restoreErr) {
        const reason = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        failureNote =
          `; restoring lock.json and state.json from snapshot ${snapshot.snapshotId} also failed (${reason}), ` +
          `run dshenv rollback ${operationId} --yes`;
      }
      if (failedStep && !failureNote) {
        failureNote = await recoveryHint(paths, operationId, installed);
      }
    }

    if (err instanceof DshError) {
      err.message += failureNote;
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new DegradedError(`Apply failed: ${message}${failureNote}`);
  }
}
