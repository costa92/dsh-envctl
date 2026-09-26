import type {
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState
} from '../domain.js';
import type { EnvironmentInventory } from '../inventory/profile-reader.js';
import { computePatchDigest } from '../patch/patch.js';

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

export interface EnvironmentPlan {
  hasChanges: boolean;
  operations: PlanOperation[];
  unmanaged: UnmanagedPlugin[];
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
  return spec?.match(/#([0-9a-f]{7,40})$/i)?.[1].toLowerCase();
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

function isSameCommit(a: string, b: string): boolean {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left.startsWith(right) || right.startsWith(left);
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

  if (!manifest) {
    // No manifest, inventory plugins are unmanaged
    for (const [profName, profInv] of Object.entries(inventory.profiles)) {
      for (const pkgName of Object.keys(profInv.plugins)) {
        unmanaged.push({ profile: profName, package: pkgName });
      }
    }
    return {
      hasChanges: false,
      operations: [],
      unmanaged
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

      if (pluginManifest.source.type === 'git' && !gitLockCommit) {
        operations.push({
          kind: 'blocked',
          profile: profName,
          alias,
          package: pkgName,
          reason: 'Git source has no locked commit; refusing to invent HEAD',
          blockedReason: 'Git source has no locked commit; refusing to invent HEAD',
          targetEnabled
        });
        continue;
      }

      // A plugin may need several operations; apply requires convergence in a single run.
      const isInstalled = Boolean(installed?.installed);
      const currentVersion = installed?.version;
      const currentEnabled = isInstalled ? (installed?.enabled ?? true) : undefined;

      if (!isInstalled) {
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
        const installedCommit =
          pluginManifest.source.type === 'git' ? commitFromGitSpec(installed?.resolvedSource) : undefined;
        if (targetVersion && currentVersion && targetVersion !== currentVersion) {
          operations.push({
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: `Version mismatch: current ${currentVersion} != target ${targetVersion}`,
            currentVersion,
            targetVersion,
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
        } else if (gitLockCommit && installedCommit && !isSameCommit(installedCommit, gitLockCommit)) {
          operations.push({
            kind: 'update',
            profile: profName,
            alias,
            package: pkgName,
            reason: `Commit mismatch: current ${installedCommit} != locked ${gitLockCommit}`,
            currentVersion: installedCommit,
            targetVersion: gitLockCommit,
            currentEnabled,
            targetEnabled
          });
        }
        if (currentEnabled !== targetEnabled) {
          operations.push({
            kind: targetEnabled ? 'enable' : 'disable',
            profile: profName,
            alias,
            package: pkgName,
            reason: `Enable state mismatch: current ${currentEnabled} != target ${targetEnabled}`,
            currentEnabled,
            targetEnabled
          });
        }
      }

      if (pluginManifest.patches && pluginManifest.patches.length > 0) {
        const actualPatches = profInv?.managedPatches ?? [];
        const needsConfigure = pluginManifest.patches.some((expected) => {
          const digest = computePatchDigest(expected.config);
          return !actualPatches.some(
            (actual) =>
              actual.plugin === alias &&
              actual.id === expected.id &&
              actual.isDigestValid &&
              actual.digest === digest
          );
        });
        if (needsConfigure) {
          operations.push({
            kind: 'configure',
            profile: profName,
            alias,
            package: pkgName,
            reason: 'Managed configuration patch is missing or digest does not match',
            currentEnabled,
            targetEnabled
          });
        }
      }
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
  }

  // Sort operations deterministically: profile -> package -> kind
  operations.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    if (a.package !== b.package) return a.package.localeCompare(b.package);
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  });

  unmanaged.sort((a, b) => {
    if (a.profile !== b.profile) return a.profile.localeCompare(b.profile);
    return a.package.localeCompare(b.package);
  });

  return {
    hasChanges: operations.length > 0,
    operations,
    unmanaged
  };
}

export function buildStatus(
  manifest: EnvironmentManifest | null,
  lock: EnvironmentLock | null,
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
  } else if (plan.unmanaged.length > 0) {
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
      } else if (blocked.has(key)) {
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
        if (blocked.has(key)) {
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
