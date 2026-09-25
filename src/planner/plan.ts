import type {
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState
} from '../domain.js';
import type { EnvironmentInventory } from '../inventory/profile-reader.js';

export type OperationKind =
  | 'install'
  | 'update'
  | 'enable'
  | 'disable'
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

export interface EnvironmentPlan {
  hasChanges: boolean;
  operations: PlanOperation[];
  unmanaged: UnmanagedPlugin[];
}

export type StableStatus =
  | 'clean'
  | 'drifted'
  | 'unmanaged'
  | 'blocked'
  | 'missing-lock'
  | 'missing-manifest'
  | 'degraded';

export interface EnvironmentStatusSummary {
  status: StableStatus;
  hasChanges: boolean;
  operationCounts: Record<OperationKind, number>;
  unmanagedCount: number;
  profilesCount: number;
}

const KIND_ORDER: Record<OperationKind, number> = {
  install: 1,
  update: 2,
  enable: 3,
  disable: 4,
  configure: 5,
  blocked: 6
};

export function buildPlan(
  manifest: EnvironmentManifest | null,
  lock: EnvironmentLock | null,
  inventory: EnvironmentInventory
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

      let targetVersion: string | undefined;
      if (pluginManifest.source.type === 'npm') {
        targetVersion =
          lockEntry?.source?.type === 'npm'
            ? lockEntry.source.resolvedVersion
            : pluginManifest.source.version;
      }

      const installed = profInv?.plugins?.[pkgName];

      if (!installed || !installed.installed) {
        operations.push({
          kind: 'install',
          profile: profName,
          alias,
          package: pkgName,
          reason: 'Plugin is declared in manifest but not installed in profile',
          targetVersion,
          targetEnabled
        });
      } else {
        const currentVersion = installed.version;
        const currentEnabled = installed.enabled ?? true;

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
        } else if (currentEnabled !== targetEnabled) {
          operations.push({
            kind: targetEnabled ? 'enable' : 'disable',
            profile: profName,
            alias,
            package: pkgName,
            reason: `Enable state mismatch: current ${currentEnabled} != target ${targetEnabled}`,
            currentEnabled,
            targetEnabled
          });
        } else if (pluginManifest.patches && pluginManifest.patches.length > 0) {
          operations.push({
            kind: 'configure',
            profile: profName,
            alias,
            package: pkgName,
            reason: 'Configuration patches pending verification/application',
            currentEnabled,
            targetEnabled
          });
        }
      }
    }
  }

  // Check actual installed plugins not in manifest -> unmanaged (never remove)
  for (const [profName, profInv] of Object.entries(inventory.profiles)) {
    const profManifest = manifestProfiles[profName];
    const expectedPackages = new Set<string>();
    if (profManifest) {
      for (const p of Object.values(profManifest.plugins)) {
        expectedPackages.add(p.package);
      }
    }

    for (const [pkgName, instInfo] of Object.entries(profInv.plugins)) {
      if (!expectedPackages.has(pkgName)) {
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
    configure: 0,
    blocked: 0
  };

  for (const op of plan.operations) {
    operationCounts[op.kind] = (operationCounts[op.kind] || 0) + 1;
  }

  let status: StableStatus = 'clean';
  if (!manifest) {
    status = 'missing-manifest';
  } else if (!lock) {
    status = 'missing-lock';
  } else if (operationCounts.blocked > 0) {
    status = 'blocked';
  } else if (plan.hasChanges) {
    status = 'drifted';
  } else if (plan.unmanaged.length > 0) {
    status = 'unmanaged';
  }

  return {
    status,
    hasChanges: plan.hasChanges,
    operationCounts,
    unmanagedCount: plan.unmanaged.length,
    profilesCount: Object.keys(inventory.profiles).length
  };
}
