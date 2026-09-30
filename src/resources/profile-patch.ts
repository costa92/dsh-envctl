import type { EnvironmentManifest, ProfilePatch } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentInventory } from '../inventory/profile-reader.js';
import type { PluginOperation, ProfilePatchOperation, UnmanagedPatches } from '../planner/plan.js';
import { writeProfilePatches } from '../apply/patches.js';
import { describeProfilePatch, digestProfilePatches } from '../profile-patches/entries.js';
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
      reason: "Profile patches were edited in DSH; run 'dshenv pull' to keep the edits, or apply to overwrite them"
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
