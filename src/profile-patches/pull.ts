import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { EnvironmentPaths } from '../environment/paths.js';
import type {
  CaptureDocument,
  EnvironmentLock,
  EnvironmentManifest,
  EnvironmentOverlay,
  EnvironmentState,
  PluginLockEntry,
  ProfilePatch,
  SourceType
} from '../domain.js';
import { ValidationError, missingManifestError } from '../errors.js';
import { readEnvironmentInventory, type EnvironmentInventory, type InstalledPluginInfo } from '../inventory/profile-reader.js';
import { loadLock, loadManifest, loadState, serializeLock, serializeManifest, serializeState, withResources } from '../manifest/files.js';
import { captureEnvironment } from '../capture/capture.js';
import { freeAlias } from '../adopt/adopt.js';
import { buildPlan } from '../planner/plan.js';
import { calculateSourceDigest } from '../source/local.js';
import * as path from 'node:path';
import { ownedSkillDigests, remoteSkillNames, replaceSkillDir, skillOwnership } from '../resources/skill.js';
import { readOverlay } from '../overlay/effective.js';
import { mergeManifest } from '../overlay/merge.js';
import { overlayFilePath, writeSelectionFile, type OverlaySelection } from '../overlay/selection.js';
import { saveOverlay, setOverlayPluginFields } from '../overlay/write.js';
import { readRemoteConfig } from '../remote/schema.js';
import { readLocalLock, remoteOwnedKey } from '../remote/ownership.js';
import { readProfilePatchFile, rewriteProfilePatchFile } from '../apply/patches.js';
import { createEnvironmentSnapshot, restoreEnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { writeAtomic } from '../io/atomic-file.js';
import { withEnvironmentLock } from '../io/lock.js';
import {
  describeProfilePatch,
  diffProfilePatches,
  digestProfilePatches,
  localPatchEntries,
  mergeDshPatches,
  overrideKey,
  readProfilePatchState,
  removeUnmanagedEntries,
  replaceProfileBlock
} from './entries.js';

// The overlay pull creates for machine-local entries when none is selected.
export const LOCAL_OVERLAY = 'local';

export interface PullOptions {
  profiles?: string[];
  // When both sides changed since the last apply: which one wins.
  prefer?: 'dsh' | 'manifest';
  dryRun?: boolean;
  selection: OverlaySelection | null;
  // False under --no-overlay, where machine-local entries have no overlay to go to.
  allowOverlayCreation: boolean;
  // Loose skills in $DSH_HOME/skills are home-wide; false leaves them out.
  skills?: boolean;
  // False leaves plugins not in the manifest out, e.g. after adopt took only the ones its candidate lists.
  plugins?: boolean;
}

export interface PluginPullChange {
  profile: string;
  alias: string;
  package: string;
  sourceType: SourceType;
  enabled: boolean;
  layer: 'base' | 'overlay';
  overlayName?: string;
}

export interface SkillPullChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface ProfilePullChange {
  profile: string;
  from: 'dsh' | 'manifest';
  added: string[];
  changed: string[];
  removed: string[];
  // Entries the profile now declares in the base manifest and in the overlay.
  base: number;
  overlay: number;
  overlayName?: string;
}

export interface PullResult {
  dryRun: boolean;
  changes: ProfilePullChange[];
  skills?: SkillPullChanges;
  plugins?: PluginPullChange[];
  // Plugins not in the manifest that could not be taken over, as capture reports them.
  warnings?: string[];
  overlayCreated?: string;
  operationId?: string;
  snapshotId?: string;
}

interface ProfileRead {
  profile: string;
  content: string;
  desired: ProfilePatch[];
  expected: ProfilePatch[];
  from: 'dsh' | 'manifest';
}

function effectivePatches(base: EnvironmentManifest, overlay: EnvironmentOverlay | null, name: string | null, profile: string): ProfilePatch[] {
  const manifest = overlay && name ? mergeManifest(base, overlay, name).manifest : base;
  return manifest.profiles[profile]?.patches ?? [];
}

function describeChanges(expected: ProfilePatch[], desired: ProfilePatch[]): Pick<ProfilePullChange, 'added' | 'changed' | 'removed'> {
  const keyed = (entries: ProfilePatch[]) => new Map(entries.map((entry) => [overrideKey(entry) ?? JSON.stringify(entry), entry]));
  const before = keyed(expected);
  const after = keyed(desired);
  return {
    added: desired.filter((entry) => !before.has(overrideKey(entry) ?? JSON.stringify(entry))).map(describeProfilePatch),
    changed: desired
      .filter((entry) => {
        const previous = before.get(overrideKey(entry) ?? JSON.stringify(entry));
        return previous !== undefined && !isDeepStrictEqual(previous, entry);
      })
      .map(describeProfilePatch),
    removed: expected.filter((entry) => !after.has(overrideKey(entry) ?? JSON.stringify(entry))).map(describeProfilePatch)
  };
}

function setBasePatches(manifest: EnvironmentManifest, profile: string, entries: ProfilePatch[]): void {
  const target = (manifest.profiles[profile] ??= { plugins: {} });
  if (entries.length > 0) {
    target.patches = entries;
  } else {
    delete target.patches;
  }
}

function setOverlayPatches(overlay: EnvironmentOverlay, profile: string, entries: ProfilePatch[]): void {
  const profiles = (overlay.profiles ??= {});
  const target = (profiles[profile] ??= {});
  if (entries.length > 0) {
    target.patches = entries;
  } else {
    delete target.patches;
  }
}

export async function pullProfilePatches(paths: EnvironmentPaths, options: PullOptions): Promise<PullResult> {
  return withEnvironmentLock(paths, () => pullUnderLock(paths, options));
}

async function pullUnderLock(paths: EnvironmentPaths, options: PullOptions): Promise<PullResult> {
  if (!fs.existsSync(paths.manifestFile)) {
    throw missingManifestError(paths.manifestFile);
  }
  const base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
  const selectedName = options.selection?.name ?? null;
  const selectedOverlay = selectedName ? readOverlay(paths, selectedName) : null;
  const remote = readRemoteConfig(paths);
  const baseOwnedByRemote = remote !== null && remoteOwnedKey(paths, remote, paths.manifestFile) !== null;

  const inventory = await readEnvironmentInventory(paths);
  for (const profile of options.profiles ?? []) {
    if (!inventory.profiles[profile]) {
      throw new ValidationError(`Profile not found: ${profile}`);
    }
  }
  const profiles = options.profiles ?? Object.keys(inventory.profiles).sort();

  const reads: ProfileRead[] = [];
  const conflicts: string[] = [];
  for (const profile of profiles) {
    const content = await readProfilePatchFile(paths, profile);
    const state = readProfilePatchState(content, profile);
    const expected = effectivePatches(base, selectedOverlay, selectedName, profile);
    const dshChanged = state.unmanaged.length > 0 || (state.block !== null && !state.block.isDigestValid);
    if (!dshChanged) {
      continue;
    }
    const manifestChanged = state.block ? state.block.digest !== digestProfilePatches(expected) : expected.length > 0;
    if (manifestChanged && !options.prefer) {
      conflicts.push(profile);
      continue;
    }
    const from = manifestChanged && options.prefer === 'manifest' ? 'manifest' : 'dsh';
    const desired = from === 'manifest' ? expected : mergeDshPatches(state.block?.entries ?? [], state.unmanaged);
    reads.push({ profile, content, desired, expected, from });
  }
  const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
  const skills = options.skills === false ? null : planSkillPull(inventory.skills ?? { declared: {}, live: {} }, ownedSkillDigests(state), options.prefer);
  const conflictNames = [
    ...(conflicts.length > 0 ? [`Profile patches of ${conflicts.join(', ')}`] : []),
    ...(skills && skills.conflicts.length > 0 ? [`skill ${skills.conflicts.join(', ')}`] : [])
  ];
  if (conflictNames.length > 0) {
    throw new ValidationError(
      `${conflictNames.join(' and ')} changed both in DSH and in the manifest since the last apply; ` +
        "pass --prefer dsh to keep DSH's version, or --prefer manifest to keep the manifest's"
    );
  }
  const remoteSkills = remoteSkillNames(remote?.files ?? {});
  for (const action of skills?.actions ?? []) {
    if (remoteSkills.has(action.name)) {
      throw new ValidationError(
        `Skill '${action.name}' is owned by remote ${remote!.url}; change it in the team repository, or run dshenv apply to restore the team copy`
      );
    }
  }

  const lock = readLocalLock(paths);
  const captured = options.plugins === false
    ? null
    : captureUnmanagedPlugins(inventory, profiles, selectedOverlay && selectedName ? mergeManifest(base, selectedOverlay, selectedName).manifest : base, lock, state);

  const nextBase = structuredClone(base);
  let overlayName = selectedName;
  let nextOverlay = selectedOverlay ? structuredClone(selectedOverlay) : null;
  let overlayCreated: string | undefined;
  const overlayFor = (refusal: string): EnvironmentOverlay => {
    if (nextOverlay) {
      return nextOverlay;
    }
    if (!options.allowOverlayCreation) {
      throw new ValidationError(`${refusal} in an overlay; drop --no-overlay, or select one with dshenv overlay use <name>`);
    }
    overlayName = LOCAL_OVERLAY;
    nextOverlay = fs.existsSync(overlayFilePath(paths, LOCAL_OVERLAY))
      ? readOverlay(paths, LOCAL_OVERLAY)
      : { apiVersion: 'dshenv-overlay/v1' };
    overlayCreated = LOCAL_OVERLAY;
    return nextOverlay;
  };
  const counts = new Map<string, { base: number; overlay: number }>();
  for (const read of reads.filter((entry) => entry.from === 'dsh')) {
    const local = localPatchEntries(read.desired);
    const baseEntries = baseOwnedByRemote
      ? (base.profiles[read.profile]?.patches ?? [])
      : read.desired.filter((entry) => !local.includes(entry));
    const overlayEntries = diffProfilePatches(baseEntries, read.desired);
    if (!baseOwnedByRemote) {
      setBasePatches(nextBase, read.profile, baseEntries);
    }
    if (overlayEntries.length > 0) {
      overlayFor(`Profile '${read.profile}' has patch entries with machine-local paths${baseOwnedByRemote ? ' or a team-owned base' : ''}, which belong`);
    }
    if (nextOverlay) {
      setOverlayPatches(nextOverlay, read.profile, overlayEntries);
    }
    counts.set(read.profile, { base: baseEntries.length, overlay: overlayEntries.length });
  }

  const operationId = `pull-${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();
  const nextLock: EnvironmentLock = structuredClone(lock ?? { apiVersion: 'dshenv-lock/v1', profiles: {} });
  const ownership = structuredClone(state?.resources?.plugin ?? {});
  const plugins: PluginPullChange[] = [];
  for (const [profile, { plugins: capturedPlugins }] of Object.entries(captured?.manifest.profiles ?? {})) {
    for (const [capturedAlias, entry] of Object.entries(capturedPlugins)) {
      const machineLocal = entry.source.type === 'local-link' || entry.source.type === 'local-file';
      const layer = machineLocal || baseOwnedByRemote ? 'overlay' : 'base';
      const overlay = layer === 'overlay'
        ? overlayFor(`Plugin '${entry.package}' of profile '${profile}' has ${machineLocal ? 'a machine-local path' : 'a team-owned base'}, which belongs`)
        : null;
      // An alias the lock or the team already holds would pin another package's entry onto this one.
      const alias = freeAlias(
        {
          ...nextBase.profiles[profile]?.plugins,
          ...overlay?.profiles?.[profile]?.plugins,
          ...nextLock.profiles[profile]?.plugins,
          ...remote?.lockEntries[profile]
        },
        capturedAlias
      );
      if (overlay) {
        setOverlayPluginFields(overlay, profile, alias, { package: entry.package, enabled: entry.enabled, source: entry.source });
      } else {
        (nextBase.profiles[profile] ??= { plugins: {} }).plugins[alias] = entry;
      }
      const lockEntry = captured!.lock.profiles[profile]?.plugins[capturedAlias];
      if (lockEntry) {
        (nextLock.profiles[profile] ??= { plugins: {} }).plugins[alias] = await withLinkDigest(lockEntry, inventory.profiles[profile].plugins[entry.package]);
      }
      (ownership[profile] ??= {})[entry.package] = {
        package: entry.package,
        alias,
        sourceType: entry.source.type,
        lockedVersion: entry.source.type === 'npm' ? entry.source.version : undefined,
        adoptedAt: now,
        adoptedBy: operationId
      };
      plugins.push({
        profile,
        alias,
        package: entry.package,
        sourceType: entry.source.type,
        enabled: entry.enabled ?? true,
        layer,
        ...(overlay ? { overlayName: overlayName! } : {})
      });
    }
  }

  // Validates both files the way every later command will load them.
  loadManifest(serializeManifest(nextBase));
  loadLock(serializeLock(nextLock));
  const merged = nextOverlay && overlayName ? mergeManifest(nextBase, nextOverlay, overlayName).manifest : nextBase;

  const changes: ProfilePullChange[] = reads.map((read) => ({
    profile: read.profile,
    from: read.from,
    ...describeChanges(read.expected, read.desired),
    base: counts.get(read.profile)?.base ?? (nextBase.profiles[read.profile]?.patches ?? []).length,
    overlay: counts.get(read.profile)?.overlay ?? (nextOverlay?.profiles?.[read.profile]?.patches ?? []).length,
    ...(overlayName ? { overlayName } : {})
  }));
  const skillChanges = skills && skills.actions.length > 0 ? summarizeSkills(skills.actions) : undefined;
  const reported = {
    changes,
    ...(skillChanges ? { skills: skillChanges } : {}),
    ...(plugins.length > 0 ? { plugins } : {}),
    ...(captured && captured.warnings.length > 0 ? { warnings: captured.warnings } : {}),
    ...(overlayCreated ? { overlayCreated } : {})
  };
  if (options.dryRun || (reads.length === 0 && !skillChanges && plugins.length === 0)) {
    return { dryRun: Boolean(options.dryRun), ...reported };
  }

  const snapshot = await createEnvironmentSnapshot(paths, operationId, {
    overlayKeys: overlayName ? [`overlays/${overlayName}.yaml`] : []
  });
  const selectionBefore = fs.existsSync(paths.overlaySelectionFile) ? fs.readFileSync(paths.overlaySelectionFile) : null;
  // Snapshots hold only envctl files, so patch files already rewritten are put back from what was read.
  const rewritten: { read: ProfileRead; written: string }[] = [];
  try {
    if (!isDeepStrictEqual(nextBase, base)) {
      await writeAtomic(paths.manifestFile, serializeManifest(nextBase), 'overwrite');
    }
    if (nextOverlay && overlayName && !isDeepStrictEqual(nextOverlay, selectedOverlay)) {
      await saveOverlay(paths, overlayName, nextBase, nextOverlay);
    }
    if (overlayCreated && !selectedName) {
      await writeSelectionFile(paths, overlayCreated);
    }
    for (const action of skills?.actions ?? []) {
      const live = path.join(paths.dshSkillsDir, action.name);
      await replaceSkillDir(action.kind === 'removed' ? null : live, path.join(paths.skillsDir, action.name), path.join(paths.trashDir, operationId, 'envctl-skills', action.name));
    }
    if (plugins.length > 0) {
      await writeAtomic(paths.lockFile, serializeLock(nextLock), 'overwrite');
    }
    if ((skills && skills.actions.length > 0) || plugins.length > 0) {
      const base: EnvironmentState = state ?? { apiVersion: 'dshenv-state/v1', lastApplied: now, appliedLockHash: '', profiles: {} };
      const skill = skills && skills.actions.length > 0 ? skillOwnership(skills.owned) : base.resources?.skill;
      await writeAtomic(paths.stateFile, serializeState(withResources(base, { plugin: ownership, skill })), 'overwrite');
    }
    for (const read of reads) {
      let written = '';
      await rewriteProfilePatchFile(paths, read.profile, (current) => {
        if (current !== read.content) {
          throw new ValidationError(`cordis.patch.yml of profile '${read.profile}' changed during pull; run dshenv pull again`);
        }
        written = replaceProfileBlock(removeUnmanagedEntries(current), read.profile, merged.profiles[read.profile]?.patches ?? []);
        return written;
      });
      rewritten.push({ read, written });
    }
  } catch (err) {
    // DSH may have edited a rewritten file since; its edits win over the undo.
    for (const { read, written } of rewritten) {
      await rewriteProfilePatchFile(paths, read.profile, (current) => (current === written ? read.content : current)).catch(() => {});
    }
    await restoreEnvironmentSnapshot(snapshot, paths).catch(() => {});
    await (selectionBefore ? writeAtomic(paths.overlaySelectionFile, selectionBefore, 'overwrite') : writeSelectionFile(paths, null)).catch(() => {});
    throw err;
  }
  await appendJournalEntry(paths, {
    operationId,
    type: 'pull-completed',
    timestamp: new Date().toISOString(),
    details: { profiles: reads.map((read) => read.profile), plugins: plugins.map((plugin) => `${plugin.profile}/${plugin.alias}`) }
  });
  return {
    dryRun: false,
    ...reported,
    operationId,
    snapshotId: snapshot.snapshotId
  };
}

// The plugins plan reports as not in the manifest, described the way capture describes them.
function captureUnmanagedPlugins(
  inventory: EnvironmentInventory,
  profiles: string[],
  manifest: EnvironmentManifest,
  lock: EnvironmentLock | null,
  state: EnvironmentState | null
): CaptureDocument {
  const selected: EnvironmentInventory = { profiles: {} };
  for (const { profile, package: name } of buildPlan(manifest, lock, inventory, state).unmanaged) {
    if (!profiles.includes(profile)) {
      continue;
    }
    // Patch entries are pulled on their own; capture would only warn about them.
    const { profilePatches: _patches, ...source } = inventory.profiles[profile];
    (selected.profiles[profile] ??= { ...source, plugins: {} }).plugins[name] = source.plugins[name];
  }
  return captureEnvironment(selected);
}

// An install that resolves to the source directory is that directory, so its digest is what DSH loads; a copy proves nothing.
async function withLinkDigest(entry: PluginLockEntry, installed: InstalledPluginInfo | undefined): Promise<PluginLockEntry> {
  if (entry.source.type !== 'local-link' || !installed?.targetPath) {
    return entry;
  }
  try {
    if ((await fs.promises.realpath(entry.source.path)) !== installed.targetPath) {
      return entry;
    }
    return { ...entry, source: { ...entry.source, digest: await calculateSourceDigest(entry.source.path) } };
  } catch {
    return entry;
  }
}

interface SkillAction {
  name: string;
  kind: 'added' | 'changed' | 'removed';
}

// `owned` holds each skill's digest from when both sides last matched; without one, the manifest copy is the base.
function planSkillPull(
  skills: { declared: Record<string, string>; live: Record<string, string> },
  owned: Record<string, string>,
  prefer: PullOptions['prefer']
): { actions: SkillAction[]; conflicts: string[]; owned: Record<string, string> } {
  const actions: SkillAction[] = [];
  const conflicts: string[] = [];
  const nextOwned = { ...owned };
  for (const name of [...new Set([...Object.keys(skills.declared), ...Object.keys(skills.live)])].sort()) {
    const declared = skills.declared[name];
    const live = skills.live[name];
    const recorded = owned[name];
    if (live !== undefined && live === declared) {
      nextOwned[name] = live;
      continue;
    }
    // A declared skill DSH never had is apply's to install, not a deletion to pull.
    const dshChanged = live !== (recorded ?? declared) && !(live === undefined && recorded === undefined);
    if (!dshChanged) {
      continue;
    }
    const manifestChanged = recorded !== undefined && declared !== recorded;
    if (manifestChanged && !prefer) {
      conflicts.push(name);
      continue;
    }
    if (manifestChanged && prefer === 'manifest') {
      continue;
    }
    actions.push({ name, kind: declared === undefined ? 'added' : live === undefined ? 'removed' : 'changed' });
    if (live === undefined) {
      delete nextOwned[name];
    } else {
      nextOwned[name] = live;
    }
  }
  return { actions, conflicts, owned: nextOwned };
}

function summarizeSkills(actions: SkillAction[]): SkillPullChanges {
  const names = (kind: SkillAction['kind']) => actions.filter((action) => action.kind === kind).map((action) => action.name);
  return { added: names('added'), changed: names('changed'), removed: names('removed') };
}
