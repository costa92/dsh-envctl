import type { EnvironmentManifest, ProfilePatch } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentInventory } from '../inventory/profile-reader.js';
import type { PluginOperation, ProfilePatchOperation, UnmanagedPatches } from '../planner/plan.js';
import { isDeepStrictEqual } from 'node:util';
import { readProfilePatchFile, rewriteProfilePatchFile, writeProfilePatches } from '../apply/patches.js';
import { ValidationError } from '../errors.js';
import {
  describeProfilePatch,
  digestProfilePatches,
  mergeDshPatches,
  overrideKey,
  readProfilePatchState,
  removeUnmanagedEntries,
  replaceProfileBlock
} from '../profile-patches/entries.js';
import { isPresetPatch } from '../tools/catalog.js';

export interface ProfilePatchPlan {
  operations: ProfilePatchOperation[];
  unmanaged: UnmanagedPatches[];
  // Agent presets a manifest patch restates whole (dshenv tools); DSH upgrades to them no longer apply.
  pinnedPresets: Array<{ profile: string; id: string }>;
}

// A profile block can only be written once the plugin installs that create its profile have run.
export function planProfilePatches(
  manifest: EnvironmentManifest,
  inventory: EnvironmentInventory,
  pluginOperations: PluginOperation[]
): ProfilePatchPlan {
  const operations: ProfilePatchOperation[] = [];
  for (const [profName, profManifest] of Object.entries(manifest.profiles)) {
    const operation = planProfileBlock(profName, profManifest.patches ?? [], inventory.profiles[profName], pluginOperations);
    if (operation) {
      operations.push(operation);
    }
  }
  // A profile the manifest dropped, e.g. with a deselected overlay, gets its block emptied like dropped entries.
  for (const [profName, profInv] of Object.entries(inventory.profiles)) {
    const operation = manifest.profiles[profName] ? null : planProfileBlock(profName, [], profInv, pluginOperations);
    if (operation) {
      operations.push(operation);
    }
  }

  const unmanaged: UnmanagedPatches[] = Object.entries(inventory.profiles)
    .filter(([, profInv]) => (profInv.profilePatches?.unmanaged.length ?? 0) > 0)
    .map(([profName, profInv]) => ({ profile: profName, entries: profInv.profilePatches!.unmanaged.map(describeProfilePatch) }))
    .sort((a, b) => a.profile.localeCompare(b.profile));
  const pinnedPresets = Object.entries(manifest.profiles).flatMap(([profile, profManifest]) =>
    (profManifest.patches ?? []).filter(isPresetPatch).map((entry) => ({ profile, id: String(entry.id) }))
  );
  return { operations, unmanaged, pinnedPresets };
}

function planProfileBlock(
  profile: string,
  expected: ProfilePatch[],
  profInv: EnvironmentInventory['profiles'][string] | undefined,
  pluginOperations: PluginOperation[]
): ProfilePatchOperation | null {
  const base = { resource: 'profile-patch', profile } as const;
  if (!profInv) {
    if (expected.length === 0) {
      return null;
    }
    // DSH creates the profile when it installs a plugin into it; without one there is nowhere to write.
    if (pluginOperations.some((op) => op.profile === profile && op.kind === 'install')) {
      return { ...base, kind: 'configure', reason: 'Profile patches are not written yet' };
    }
    const reason = `Profile '${profile}' does not exist yet; start DSH with --profile ${profile} once, or declare a plugin in it`;
    return { ...base, kind: 'blocked', reason, blockedReason: reason };
  }
  const block = profInv.profilePatches?.block ?? null;
  if (!block) {
    return expected.length > 0 ? { ...base, kind: 'configure', reason: 'Profile patches are not written yet' } : null;
  }
  if (!block.isDigestValid) {
    return {
      ...base,
      kind: 'configure',
      reason: "Profile patches were edited in DSH; run 'dshenv pull --yes' to keep the edits, or apply to overwrite them"
    };
  }
  if (block.digest === digestProfilePatches(expected)) {
    return null;
  }
  return {
    ...base,
    kind: 'configure',
    reason: expected.length > 0 ? 'Profile patches changed in the manifest' : 'Profile patches are no longer declared'
  };
}

export async function applyProfilePatchOperation(
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  operation: ProfilePatchOperation
): Promise<() => Promise<void>> {
  return writeProfilePatches(paths, operation.profile, manifest.profiles[operation.profile]?.patches ?? []);
}

// A profile whose patch entries changed in DSH, and the entries pull makes it declare.
export interface ProfilePatchImport {
  profile: string;
  content: string;
  desired: ProfilePatch[];
  expected: ProfilePatch[];
  from: 'dsh' | 'manifest';
}

// Profiles changed only in DSH are read; one the manifest changed too is a conflict unless prefer settles it.
export async function planProfilePatchImport(
  paths: EnvironmentPaths,
  profiles: string[],
  expectedFor: (profile: string) => ProfilePatch[],
  prefer: 'dsh' | 'manifest' | undefined
): Promise<{ reads: ProfilePatchImport[]; conflicts: string[] }> {
  const reads: ProfilePatchImport[] = [];
  const conflicts: string[] = [];
  for (const profile of profiles) {
    const content = await readProfilePatchFile(paths, profile);
    const state = readProfilePatchState(content, profile);
    const expected = expectedFor(profile);
    const dshChanged = state.unmanaged.length > 0 || (state.block !== null && !state.block.isDigestValid);
    if (!dshChanged) {
      continue;
    }
    const manifestChanged = state.block ? state.block.digest !== digestProfilePatches(expected) : expected.length > 0;
    if (manifestChanged && !prefer) {
      conflicts.push(profile);
      continue;
    }
    const from = manifestChanged && prefer === 'manifest' ? 'manifest' : 'dsh';
    const desired = from === 'manifest' ? expected : mergeDshPatches(state.block?.entries ?? [], state.unmanaged);
    reads.push({ profile, content, desired, expected, from });
  }
  return { reads, conflicts };
}

export function describeProfilePatchImport(expected: ProfilePatch[], desired: ProfilePatch[]): { added: string[]; changed: string[]; removed: string[] } {
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

// Rewrites the profile's block to the entries it now declares and drops the entries outside it; returns what it wrote.
export async function importProfilePatchFile(paths: EnvironmentPaths, read: ProfilePatchImport, entries: ProfilePatch[]): Promise<string> {
  let written = '';
  await rewriteProfilePatchFile(paths, read.profile, (current) => {
    if (current !== read.content) {
      throw new ValidationError(`cordis.patch.yml of profile '${read.profile}' changed during pull; run dshenv pull --yes again`);
    }
    written = replaceProfileBlock(removeUnmanagedEntries(current), read.profile, entries);
    return written;
  });
  return written;
}
