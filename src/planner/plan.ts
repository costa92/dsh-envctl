import * as path from 'node:path';
import type {
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState,
  ProfilePatch
} from '../domain.js';
import type { EnvironmentInventory } from '../inventory/profile-reader.js';
import { computePatchDigest } from '../patch/patch.js';
import { PROFILE_PATCHES_ALIAS, describeProfilePatch, digestProfilePatches } from '../profile-patches/entries.js';
import { planSkills, type SkillOperation } from '../skills/skills.js';
import { isPresetPatch } from '../tools/catalog.js';

export type OperationKind =
  | 'install'
  | 'update'
  | 'enable'
  | 'disable'
  | 'remove'
  | 'configure'
  | 'blocked';

export interface PlanOperation {
  kind: OperationKind;
  profile: string;
  alias: string;
  package: string;
  reason: string;
  currentVersion?: string;
  targetVersion?: string;
  currentEnabled?: boolean;
  targetEnabled?: boolean;
  blockedReason?: string;
}

export interface UnmanagedPlugin {
  profile: string;
  package: string;
}

// profile -> alias -> current digest of the plugin's local source directory
export type LocalSourceDigests = Record<string, Record<string, string>>;

// Declared and installed, but without the evidence to tell whether it matches; reported, never blocking.
export interface UnverifiedPlugin {
  profile: string;
  alias: string;
  package: string;
  reason: string;
}

// Patch entries outside dshenv's blocks, e.g. settings changed in DSH; `dshenv pull` takes them over.
export interface UnmanagedPatches {
  profile: string;
  entries: string[];
}

export interface EnvironmentPlan {
  hasChanges: boolean;
  operations: PlanOperation[];
  unmanaged: UnmanagedPlugin[];
  unverified: UnverifiedPlugin[];
  unmanagedPatches: UnmanagedPatches[];
  // Loose skills in $DSH_HOME/skills; home-wide, so kept apart from the per-profile operations.
  skillOperations: SkillOperation[];
  unmanagedSkills: string[];
  // Agent presets a manifest patch restates whole (dshenv tools); DSH upgrades to them no longer apply.
  pinnedPresets?: Array<{ profile: string; id: string }>;
}

export type StableStatus =
  | 'healthy'
  | 'disabled'
  | 'restart-required'
  | 'drifted'
  | 'unmanaged'
  | 'incompatible'
  | 'degraded';

export interface PluginStatusEntry {
  profile: string;
  package: string;
  status: StableStatus;
}

export interface EnvironmentStatusSummary {
  status: StableStatus;
  hasChanges: boolean;
  operationCounts: Record<OperationKind, number>;
  unmanagedCount: number;
  profilesCount: number;
  plugins: PluginStatusEntry[];
}

const KIND_ORDER: Record<OperationKind, number> = {
  install: 1,
  update: 2,
  enable: 3,
  disable: 4,
  remove: 5,
  configure: 6,
  blocked: 7
};

// Only a hex fragment proves which commit is installed; branch names and bare URLs are not evidence.
function commitFromGitSpec(spec: string | undefined): string | undefined {
  return spec?.match(/#([0-9a-f]{7,64})$/i)?.[1].toLowerCase();
}

function lockedLocalDigest(
  source: EnvironmentLock['profiles'][string]['plugins'][string]['source'] | undefined,
  type: 'local-file' | 'local-link'
): string | undefined {
  return source?.type === type ? source.digest : undefined;
}

type LockedSource = EnvironmentLock['profiles'][string]['plugins'][string]['source'] | undefined;
type ManifestSource = EnvironmentManifest['profiles'][string]['plugins'][string]['source'];

// The lock is a single per-machine file shared by every overlay, so it may only pin what the
// effective manifest declares, never override it.
export function lockedGitCommit(source: ManifestSource, locked: LockedSource): string | undefined {
  return source.type === 'git' && locked?.type === 'git' && locked.url === source.url ? locked.commit : undefined;
}

// Without a readable source an installed local plugin would read as in sync while nothing proves it.
function unreadableLocalSource(source: ManifestSource, localDigest: string | undefined, digestsRead: boolean): string | undefined {
  if ((source.type === 'local-file' || source.type === 'local-link') && digestsRead && !localDigest) {
    return `Local source ${source.path} cannot be read, so the installed copy cannot be checked against it`;
  }
  return undefined;
}

// The installed spec is the evidence; the lock stands in when the inventory could not resolve one.
function localPathMoved(
  type: 'local-file' | 'local-link',
  declared: string,
  installed: string | undefined,
  locked: LockedSource
): boolean {
  const current = installed ?? (locked?.type === type ? locked.path : undefined);
  return current !== undefined && path.normalize(current) !== path.normalize(declared);
}

function isSameCommit(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left.startsWith(right) || right.startsWith(left);
}

// The lock alone decides the installed commit; a manifest commit it disagrees with must not be silently ignored.
function gitCommitBlock(declared: string | undefined, locked: string | undefined): string | undefined {
  if (!locked) {
    return declared
      ? `Git source declares commit ${declared} in the manifest, but only lock.json pins git commits; run 'dshenv source clone <url> --profile <profile>' to lock it`
      : 'Git source has no locked commit; refusing to invent HEAD';
  }
  if (declared && !isSameCommit(declared, locked)) {
    return `Git source declares commit ${declared} in the manifest, but the locked commit is ${locked}; drop the manifest commit or move the lock with 'dshenv source pull --profile <profile> --ref ${declared}'`;
  }
  return undefined;
}

// The base and app bundles DSH selects when it creates a profile; leaving them undeclared is the normal case.
const DSH_BUILT_IN_BUNDLES: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-app'
]);

function isDshBuiltIn(plugin: { name: string; sourceType?: string }): boolean {
  return plugin.sourceType === 'in-box' && DSH_BUILT_IN_BUNDLES.has(plugin.name);
}

export function buildPlan(
  manifest: EnvironmentManifest | null,
  lock: EnvironmentLock | null,
  inventory: EnvironmentInventory,
  state?: EnvironmentState | null,
  localDigests?: LocalSourceDigests
): EnvironmentPlan {
  const operations: PlanOperation[] = [];
  const unmanaged: UnmanagedPlugin[] = [];
  const unverified: UnverifiedPlugin[] = [];

  if (!manifest) {
    // No manifest, inventory plugins are unmanaged
    for (const [profName, profInv] of Object.entries(inventory.profiles)) {
      for (const pkgName of Object.keys(profInv.plugins)) {
        if (!isDshBuiltIn(profInv.plugins[pkgName])) {
          unmanaged.push({ profile: profName, package: pkgName });
        }
      }
    }
    return {
      hasChanges: false,
      operations: [],
      unmanaged,
      unverified,
      unmanagedPatches: [],
      skillOperations: [],
      unmanagedSkills: []
    };
  }

  const manifestProfiles = manifest.profiles || {};

  // Check expected vs actual
  for (const [profName, profManifest] of Object.entries(manifestProfiles)) {
    const profInv = inventory.profiles[profName];
    const profLock = lock?.profiles?.[profName]?.plugins || {};

    for (const [alias, pluginManifest] of Object.entries(profManifest.plugins)) {
      const pkgName = pluginManifest.package;
      const targetEnabled = pluginManifest.enabled ?? true;
      const lockEntry = profLock[alias];

      const targetVersion = pluginManifest.source.type === 'npm' ? pluginManifest.source.version : undefined;

      const installed = profInv?.plugins?.[pkgName];
      const gitLockCommit = lockedGitCommit(pluginManifest.source, lockEntry?.source);

      const gitBlock = pluginManifest.source.type === 'git' ? gitCommitBlock(pluginManifest.source.commit, gitLockCommit) : undefined;
      if (gitBlock) {
        operations.push({
          kind: 'blocked',
          profile: profName,
          alias,
          package: pkgName,
          reason: gitBlock,
          blockedReason: gitBlock,
          targetEnabled
        });
        continue;
      }

      // A plugin may need several operations; apply requires convergence in a single run.
      // A bundle entry without a dependency reads as in-box, which proves nothing about a package declared from elsewhere.
      const isInstalled = Boolean(installed?.installed) && !(installed?.sourceType === 'in-box' && pluginManifest.source.type !== 'in-box');
      const currentVersion = installed?.version;
      const currentEnabled = isInstalled ? (installed?.enabled ?? true) : undefined;

      if (!isInstalled && pluginManifest.source.type === 'in-box') {
        // In-box plugins ship with DSH and are only inventoried through the bundles, so absence means disabled.
        if (targetEnabled) {
          operations.push({
            kind: 'enable',
            profile: profName,
            alias,
            package: pkgName,
            reason: 'In-box plugin is not selected in the profile bundles',
            currentEnabled: false,
            targetEnabled
          });
        }
      } else if (!isInstalled) {
        operations.push({
          kind: 'install',
          profile: profName,
          alias,
          package: pkgName,
          reason: 'Plugin is declared in manifest but not installed in profile',
          targetVersion,
          targetEnabled
        });
        // DSH plugin add selects the bundle, so only an explicit disable needs a follow-up.
        if (!targetEnabled) {
          operations.push({
            kind: 'disable',
            profile: profName,
            alias,
            package: pkgName,
            reason: 'Plugin is installed disabled',
            targetEnabled
          });
        }
      } else {
        const operationsBefore = operations.length;
        const installedCommit =
          pluginManifest.source.type === 'git' ? commitFromGitSpec(installed?.resolvedSource) : undefined;
        const installedType = installed?.sourceType;
        const declaredType = pluginManifest.source.type;
        const unverifiable = unreadableLocalSource(pluginManifest.source, localDigests?.[profName]?.[alias], localDigests !== undefined);
        if (unverifiable) {
          unverified.push({ profile: profName, alias, package: pkgName, reason: unverifiable });
        }
        if (installedType && installedType !== declaredType && installedType !== 'in-box' && declaredType !== 'in-box') {
          operations.push({
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: `Source type changed: installed ${installedType} != declared ${declaredType}`,
            currentEnabled,
            targetEnabled
          });
        } else if (targetVersion && (currentVersion ? targetVersion !== currentVersion : installedType === 'npm')) {
          // A reinstall writes the version that proves the package matches.
          operations.push({
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: currentVersion
              ? `Version mismatch: current ${currentVersion} != target ${targetVersion}`
              : `Installed npm package reports no version; reinstalling ${targetVersion}`,
            currentVersion,
            targetVersion,
            currentEnabled,
            targetEnabled
          });
        } else if (
          (pluginManifest.source.type === 'local-file' || pluginManifest.source.type === 'local-link') &&
          localPathMoved(pluginManifest.source.type, pluginManifest.source.path, installed?.resolvedSource, lockEntry?.source)
        ) {
          operations.push({
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: `Local source path changed to ${pluginManifest.source.path}`,
            currentEnabled,
            targetEnabled
          });
        } else if (
          (pluginManifest.source.type === 'local-file' || pluginManifest.source.type === 'local-link') &&
          localDigests?.[profName]?.[alias] &&
          lockedLocalDigest(lockEntry?.source, pluginManifest.source.type) !== localDigests[profName][alias]
        ) {
          // Without a recorded digest the installed copy cannot be proven to match the source.
          const recorded = lockedLocalDigest(lockEntry?.source, pluginManifest.source.type);
          operations.push({
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: recorded
              ? `Local source changed: recorded ${recorded} != current ${localDigests[profName][alias]}`
              : 'Local source has no recorded digest',
            currentVersion: recorded,
            targetVersion: localDigests[profName][alias],
            currentEnabled,
            targetEnabled
          });
        } else if (gitLockCommit && installedType === 'git' && (!installedCommit || !isSameCommit(installedCommit, gitLockCommit))) {
          // A spec such as #main names no commit, so the installed code cannot be shown to match the lock.
          operations.push({
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: installedCommit
              ? `Commit mismatch: current ${installedCommit} != locked ${gitLockCommit}`
              : `Installed git spec pins no commit; reinstalling at locked ${gitLockCommit}`,
            currentVersion: installedCommit,
            targetVersion: gitLockCommit,
            currentEnabled,
            targetEnabled
          });
        }
        // An update runs DSH plugin add, which selects the bundle, so a disabled plugin is disabled again after it.
        const reselected = !targetEnabled && operations.length > operationsBefore;
        if (currentEnabled !== targetEnabled || reselected) {
          operations.push({
            kind: targetEnabled ? 'enable' : 'disable',
            profile: profName,
            alias,
            package: pkgName,
            reason: currentEnabled !== targetEnabled
              ? `Enable state mismatch: current ${currentEnabled} != target ${targetEnabled}`
              : 'Plugin stays disabled after the update',
            currentEnabled,
            targetEnabled
          });
        }
      }

      // Live blocks must match the enabled patches exactly, so dropped or disabled patches are cleared too.
      const expectedPatches = (pluginManifest.patches ?? []).filter((patch) => patch.enabled !== false);
      const livePatches = (profInv?.managedPatches ?? []).filter((actual) => actual.plugin === alias);
      const patchesInSync =
        livePatches.length === expectedPatches.length &&
        expectedPatches.every((expected, index) => {
          const actual = livePatches[index];
          return actual.id === expected.id && actual.isDigestValid && actual.digest === computePatchDigest(expected.config);
        });
      if (!patchesInSync) {
        operations.push({
          kind: 'configure',
          profile: profName,
          alias,
          package: pkgName,
          reason: expectedPatches.length > 0
            ? 'Managed configuration patch is missing or digest does not match'
            : 'Managed configuration patch is no longer declared',
          currentEnabled,
          targetEnabled
        });
      }
    }

    // DSH creates a profile only when it installs a plugin into it; without one, in-box plugins have nowhere to go.
    if (!profInv && !operations.some((op) => op.profile === profName && op.kind === 'install')) {
      const reason = `Profile '${profName}' does not exist yet; start DSH with --profile ${profName} once, or declare a plugin to install in it`;
      for (const [index, op] of operations.entries()) {
        if (op.profile === profName && op.kind !== 'blocked') {
          operations[index] = { ...op, kind: 'blocked', reason, blockedReason: reason };
        }
      }
    }

    const profileOperation = planProfilePatches(profName, profManifest.patches ?? [], profInv, operations);
    if (profileOperation) {
      operations.push(profileOperation);
    }

    // Blocks that all match still leave the file unreadable to DSH; rewriting one plugin's blocks repairs the whole file.
    const repairAlias = Object.keys(profManifest.plugins).sort()[0];
    if (profInv?.patchFileRepairable && repairAlias && !operations.some((op) => op.kind === 'configure' && op.profile === profName)) {
      operations.push({
        kind: 'configure',
        profile: profName,
        alias: repairAlias,
        package: profManifest.plugins[repairAlias].package,
        reason: 'cordis.patch.yml is not valid YAML; rewriting the managed blocks repairs it'
      });
    }
  }

  // Installed plugins not in the manifest: remove only when ownership exists.
  for (const [profName, profInv] of Object.entries(inventory.profiles)) {
    const profManifest = manifestProfiles[profName];
    const expectedPackages = new Set<string>();
    if (profManifest) {
      for (const p of Object.values(profManifest.plugins)) {
        expectedPackages.add(p.package);
      }
    }

    for (const pkgName of Object.keys(profInv.plugins)) {
      if (expectedPackages.has(pkgName)) {
        continue;
      }
      if (isDshBuiltIn(profInv.plugins[pkgName])) {
        continue;
      }
      const owned = state?.ownership?.[profName]?.[pkgName];
      if (owned && profInv.plugins[pkgName].installed) {
        operations.push({
          kind: 'remove',
          profile: profName,
          alias: owned.alias || pkgName,
          package: pkgName,
          reason: 'Owned plugin is no longer declared in the manifest'
        });
      } else {
        unmanaged.push({
          profile: profName,
          package: pkgName
        });
      }
    }

    // A profile the manifest dropped, e.g. with a deselected overlay, gets its block emptied like dropped entries.
    const profileOperation = profManifest ? null : planProfilePatches(profName, [], profInv, operations);
    if (profileOperation) {
      operations.push(profileOperation);
    }
  }

  const unmanagedPatches: UnmanagedPatches[] = Object.entries(inventory.profiles)
    .filter(([, profInv]) => (profInv.profilePatches?.unmanaged.length ?? 0) > 0)
    .map(([profName, profInv]) => ({ profile: profName, entries: profInv.profilePatches!.unmanaged.map(describeProfilePatch) }))
    .sort((a, b) => a.profile.localeCompare(b.profile));

  // Sort operations deterministically: profile -> package -> kind; profile patches go last, after the installs that create the profile.
  // Removes run first, as they clear their alias's patches and mount, which a new package under that alias may already use;
  // installs run next, as they create a profile that an in-box enable of another package writes to.
  operations.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    const profileLevel = Number(a.alias === PROFILE_PATCHES_ALIAS) - Number(b.alias === PROFILE_PATCHES_ALIAS);
    if (profileLevel !== 0) return profileLevel;
    const stage = (op: PlanOperation): number => (op.kind === 'remove' ? 0 : op.kind === 'install' ? 1 : 2);
    if (stage(a) !== stage(b)) return stage(a) - stage(b);
    if (a.package !== b.package) return a.package.localeCompare(b.package);
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  });

  unmanaged.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    return a.package.localeCompare(b.package);
  });

  const skills = inventory.skills ? planSkills(inventory.skills, state?.skills) : { operations: [], unmanaged: [] };
  const pinnedPresets = Object.entries(manifestProfiles).flatMap(([profile, profManifest]) =>
    (profManifest.patches ?? []).filter(isPresetPatch).map((entry) => ({ profile, id: String(entry.id) }))
  );

  return {
    hasChanges: operations.length > 0 || skills.operations.length > 0,
    operations,
    unmanaged,
    unverified,
    unmanagedPatches,
    skillOperations: skills.operations,
    unmanagedSkills: skills.unmanaged,
    ...(pinnedPresets.length > 0 ? { pinnedPresets } : {})
  };
}

function planProfilePatches(
  profile: string,
  expected: ProfilePatch[],
  profInv: EnvironmentInventory['profiles'][string] | undefined,
  operations: PlanOperation[]
): PlanOperation | null {
  const base = { profile, alias: PROFILE_PATCHES_ALIAS, package: PROFILE_PATCHES_ALIAS };
  if (!profInv) {
    if (expected.length === 0) {
      return null;
    }
    // DSH creates the profile when it installs a plugin into it; without one there is nowhere to write.
    if (operations.some((op) => op.profile === profile && op.kind === 'install')) {
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

export function buildStatus(
  manifest: EnvironmentManifest | null,
  state: EnvironmentState | null,
  inventory: EnvironmentInventory,
  plan: EnvironmentPlan
): EnvironmentStatusSummary {
  const operationCounts: Record<OperationKind, number> = {
    install: 0,
    update: 0,
    enable: 0,
    disable: 0,
    remove: 0,
    configure: 0,
    blocked: 0
  };

  for (const op of plan.operations) {
    operationCounts[op.kind] = (operationCounts[op.kind] || 0) + 1;
  }

  const plugins = collectPluginStatuses(manifest, state, inventory, plan);

  let status: StableStatus = 'healthy';
  if (!manifest || operationCounts.blocked > 0 || plugins.some((p) => p.status === 'degraded')) {
    status = 'degraded';
  } else if (plugins.some((p) => p.status === 'incompatible')) {
    status = 'incompatible';
  } else if (
    operationCounts.install +
      operationCounts.update +
      operationCounts.enable +
      operationCounts.disable +
      operationCounts.remove +
      operationCounts.configure >
    0
  ) {
    status = 'drifted';
  } else if (plan.skillOperations.length > 0) {
    status = 'drifted';
  } else if (plan.unmanaged.length > 0 || plan.unmanagedPatches.length > 0 || plan.unmanagedSkills.length > 0) {
    status = 'unmanaged';
  } else if (plugins.some((p) => p.status === 'restart-required')) {
    status = 'restart-required';
  }

  return {
    status,
    hasChanges: plan.hasChanges,
    operationCounts,
    unmanagedCount: plan.unmanaged.length,
    profilesCount: Object.keys(inventory.profiles).length,
    plugins
  };
}

function collectPluginStatuses(
  manifest: EnvironmentManifest | null,
  state: EnvironmentState | null,
  inventory: EnvironmentInventory,
  plan: EnvironmentPlan
): PluginStatusEntry[] {
  const entries: PluginStatusEntry[] = [];
  const blocked = new Set(plan.operations.filter((op) => op.kind === 'blocked').map((op) => `${op.profile}\0${op.package}`));
  const drifted = new Set(
    plan.operations
      .filter(
        (op) =>
          op.kind === 'install' ||
          op.kind === 'update' ||
          op.kind === 'enable' ||
          op.kind === 'disable' ||
          op.kind === 'remove' ||
          op.kind === 'configure'
      )
      .map((op) => `${op.profile}\0${op.package}`)
  );
  const unmanaged = new Set(plan.unmanaged.map((u) => `${u.profile}\0${u.package}`));
  const unverified = new Set(plan.unverified.map((u) => `${u.profile}\0${u.package}`));

  const seen = new Set<string>();
  const push = (profile: string, pkg: string, status: StableStatus) => {
    const key = `${profile}\0${pkg}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({ profile, package: pkg, status });
  };

  for (const [profName, profInv] of Object.entries(inventory.profiles)) {
    for (const pkgName of Object.keys(profInv.plugins)) {
      const key = `${profName}\0${pkgName}`;
      const stateStatus = state?.profiles?.[profName]?.plugins?.[pkgName]?.status;
      if (unmanaged.has(key)) {
        push(profName, pkgName, 'unmanaged');
      } else if (blocked.has(key) || unverified.has(key)) {
        push(profName, pkgName, 'degraded');
      } else if (drifted.has(key)) {
        push(profName, pkgName, 'drifted');
      } else if (stateStatus === 'restart-required' || stateStatus === 'incompatible' || stateStatus === 'degraded') {
        push(profName, pkgName, stateStatus);
      } else if (profInv.plugins[pkgName].enabled === false) {
        push(profName, pkgName, 'disabled');
      } else {
        push(profName, pkgName, 'healthy');
      }
    }
  }

  if (manifest) {
    for (const [profName, profManifest] of Object.entries(manifest.profiles)) {
      for (const plugin of Object.values(profManifest.plugins)) {
        const key = `${profName}\0${plugin.package}`;
        if (blocked.has(key) || unverified.has(key)) {
          push(profName, plugin.package, 'degraded');
        } else if (drifted.has(key)) {
          push(profName, plugin.package, 'drifted');
        } else {
          push(profName, plugin.package, 'healthy');
        }
      }
    }
  }

  entries.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    return a.package.localeCompare(b.package);
  });
  return entries;
}

export function planExitCode(plan: { hasChanges: boolean; operations: { kind: OperationKind }[] }): number {
  if (plan.operations.some((op) => op.kind === 'blocked')) {
    return 5;
  }
  if (plan.hasChanges) {
    return 2;
  }
  return 0;
}
