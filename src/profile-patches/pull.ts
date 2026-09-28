import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentManifest, EnvironmentOverlay, ProfilePatch } from '../domain.js';
import { ValidationError } from '../errors.js';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { loadManifest, serializeManifest } from '../manifest/files.js';
import { readOverlay } from '../overlay/effective.js';
import { mergeManifest } from '../overlay/merge.js';
import { overlayFilePath, writeSelectionFile, type OverlaySelection } from '../overlay/selection.js';
import { saveOverlay } from '../overlay/write.js';
import { readRemoteConfig } from '../remote/schema.js';
import { remoteOwnedKey } from '../remote/ownership.js';
import { readProfilePatchFile, rewriteProfilePatchFile } from '../apply/patches.js';
import { createEnvironmentSnapshot, restoreEnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { writeAtomic } from '../io/atomic-file.js';
import { withEnvironmentLock } from '../io/lock.js';
import {
  containsLocalPath,
  describeProfilePatch,
  diffProfilePatches,
  digestProfilePatches,
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
    throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
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
  if (conflicts.length > 0) {
    throw new ValidationError(
      `Profile patches of ${conflicts.join(', ')} changed both in DSH and in the manifest since the last apply; ` +
        "pass --prefer dsh to keep DSH's version, or --prefer manifest to keep the manifest's"
    );
  }

  const nextBase = structuredClone(base);
  let overlayName = selectedName;
  let nextOverlay = selectedOverlay ? structuredClone(selectedOverlay) : null;
  let overlayCreated: string | undefined;
  const counts = new Map<string, { base: number; overlay: number }>();
  for (const read of reads.filter((entry) => entry.from === 'dsh')) {
    const local = read.desired.filter(containsLocalPath);
    const baseEntries = baseOwnedByRemote
      ? (base.profiles[read.profile]?.patches ?? [])
      : read.desired.filter((entry) => !local.includes(entry));
    const overlayEntries = diffProfilePatches(baseEntries, read.desired);
    if (!baseOwnedByRemote) {
      setBasePatches(nextBase, read.profile, baseEntries);
    }
    if (overlayEntries.length > 0 && !nextOverlay) {
      if (!options.allowOverlayCreation) {
        throw new ValidationError(
          `Profile '${read.profile}' has patch entries with machine-local paths${baseOwnedByRemote ? ' or a team-owned base' : ''}, ` +
            'which belong in an overlay; drop --no-overlay, or select one with dshenv overlay use <name>'
        );
      }
      overlayName = LOCAL_OVERLAY;
      nextOverlay = fs.existsSync(overlayFilePath(paths, LOCAL_OVERLAY))
        ? readOverlay(paths, LOCAL_OVERLAY)
        : { apiVersion: 'dshenv-overlay/v1' };
      overlayCreated = LOCAL_OVERLAY;
    }
    if (nextOverlay) {
      setOverlayPatches(nextOverlay, read.profile, overlayEntries);
    }
    counts.set(read.profile, { base: baseEntries.length, overlay: overlayEntries.length });
  }

  // Validates both files the way every later command will load them.
  loadManifest(serializeManifest(nextBase));
  const merged = nextOverlay && overlayName ? mergeManifest(nextBase, nextOverlay, overlayName).manifest : nextBase;

  const changes: ProfilePullChange[] = reads.map((read) => ({
    profile: read.profile,
    from: read.from,
    ...describeChanges(read.expected, read.desired),
    base: counts.get(read.profile)?.base ?? (nextBase.profiles[read.profile]?.patches ?? []).length,
    overlay: counts.get(read.profile)?.overlay ?? (nextOverlay?.profiles?.[read.profile]?.patches ?? []).length,
    ...(overlayName ? { overlayName } : {})
  }));
  if (options.dryRun || reads.length === 0) {
    return { dryRun: Boolean(options.dryRun), changes, ...(overlayCreated ? { overlayCreated } : {}) };
  }

  const operationId = `pull-${crypto.randomBytes(6).toString('hex')}`;
  const snapshot = await createEnvironmentSnapshot(paths, operationId, {
    overlayKeys: overlayName ? [`overlays/${overlayName}.yaml`] : []
  });
  const selectionBefore = fs.existsSync(paths.overlaySelectionFile) ? fs.readFileSync(paths.overlaySelectionFile) : null;
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
    for (const read of reads) {
      await rewriteProfilePatchFile(paths, read.profile, (current) => {
        if (current !== read.content) {
          throw new ValidationError(`cordis.patch.yml of profile '${read.profile}' changed during pull; run dshenv pull again`);
        }
        return replaceProfileBlock(removeUnmanagedEntries(current), read.profile, merged.profiles[read.profile]?.patches ?? []);
      });
    }
  } catch (err) {
    await restoreEnvironmentSnapshot(snapshot, paths).catch(() => {});
    await (selectionBefore ? writeAtomic(paths.overlaySelectionFile, selectionBefore, 'overwrite') : writeSelectionFile(paths, null)).catch(() => {});
    throw err;
  }
  await appendJournalEntry(paths, {
    operationId,
    type: 'pull-completed',
    timestamp: new Date().toISOString(),
    details: { profiles: reads.map((read) => read.profile) }
  });
  return {
    dryRun: false,
    changes,
    ...(overlayCreated ? { overlayCreated } : {}),
    operationId,
    snapshotId: snapshot.snapshotId
  };
}
