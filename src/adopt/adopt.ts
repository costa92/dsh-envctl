import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { EnvironmentPaths } from '../environment/paths.js';
import type {
  CaptureDocument,
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState,
  PluginOwnershipRecord
} from '../domain.js';
import { readEnvironmentInventory, type EnvironmentInventory } from '../inventory/profile-reader.js';
import {
  serializeManifest,
  serializeLock,
  serializeState,
  loadManifest,
  loadLock,
  loadState
} from '../manifest/files.js';
import { writeAtomic } from '../io/atomic-file.js';
import { ValidationError } from '../errors.js';

export interface AdoptDetail {
  profile: string;
  alias: string;
  package: string;
  sourceType: string;
  version?: string;
}

export interface AdoptSummary {
  adoptedCount: number;
  profiles: string[];
  details: AdoptDetail[];
  operationId: string;
}

export function checkCandidateFreshness(
  candidate: CaptureDocument,
  inventory: EnvironmentInventory
): void {
  for (const [profileName, profileManifest] of Object.entries(candidate.manifest.profiles)) {
    const liveProfile = inventory.profiles[profileName];
    if (!liveProfile) {
      throw new ValidationError(`Candidate refers to profile "${profileName}" which does not exist in live environment`);
    }

    for (const [alias, plugin] of Object.entries(profileManifest.plugins)) {
      const livePlugin = liveProfile.plugins[plugin.package];
      if (!livePlugin || !livePlugin.installed) {
        throw new ValidationError(
          `Candidate is stale: package "${plugin.package}" in profile "${profileName}" is not currently installed in live environment`
        );
      }

      if (plugin.source.type === 'npm' && plugin.source.version && livePlugin.version) {
        if (plugin.source.version !== livePlugin.version) {
          throw new ValidationError(
            `Candidate is stale: package "${plugin.package}" version in candidate (${plugin.source.version}) does not match live installation (${livePlugin.version})`
          );
        }
      }
    }
  }
}

// Adopt rewrites these files wholesale, so an unreadable one must stop it rather than be replaced.
function readExisting<T>(kind: string, file: string, load: (content: string) => T): T {
  try {
    return load(fs.readFileSync(file, 'utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Cannot adopt: the existing ${kind} ${file} is invalid (${message}); fix or move it first`);
  }
}

export interface AdoptOptions {
  // Runs before anything is written; lets callers reject a base that an active overlay cannot merge onto.
  validateManifest?: (manifest: EnvironmentManifest) => void;
}

export async function adoptEnvironment(
  paths: EnvironmentPaths,
  candidate: CaptureDocument,
  options?: AdoptOptions
): Promise<AdoptSummary> {
  const inventory = await readEnvironmentInventory(paths);
  checkCandidateFreshness(candidate, inventory);

  const operationId = `adopt-${crypto.randomBytes(6).toString('hex')}`;
  const now = new Date().toISOString();

  let existingManifest: EnvironmentManifest = {
    apiVersion: 'dshenv/v1',
    profiles: {}
  };
  let existingLock: EnvironmentLock = {
    apiVersion: 'dshenv-lock/v1',
    profiles: {}
  };
  let existingState: EnvironmentState = {
    apiVersion: 'dshenv-state/v1',
    lastApplied: now,
    appliedLockHash: '',
    profiles: {},
    ownership: {}
  };

  if (fs.existsSync(paths.manifestFile)) {
    existingManifest = readExisting('manifest', paths.manifestFile, loadManifest);
  }
  if (fs.existsSync(paths.lockFile)) {
    existingLock = readExisting('lock', paths.lockFile, loadLock);
  }
  if (fs.existsSync(paths.stateFile)) {
    existingState = readExisting('state', paths.stateFile, loadState);
  }

  const mergedManifest: EnvironmentManifest = {
    apiVersion: 'dshenv/v1',
    environment: candidate.manifest.environment ?? existingManifest.environment,
    profiles: { ...existingManifest.profiles }
  };

  const mergedLock: EnvironmentLock = {
    apiVersion: 'dshenv-lock/v1',
    profiles: { ...existingLock.profiles }
  };

  const ownership: Record<string, Record<string, PluginOwnershipRecord>> = {
    ...(existingState.ownership ?? {})
  };

  const details: AdoptDetail[] = [];
  const profilesSet = new Set<string>();

  for (const [profileName, candProf] of Object.entries(candidate.manifest.profiles)) {
    profilesSet.add(profileName);
    if (!mergedManifest.profiles[profileName]) {
      mergedManifest.profiles[profileName] = { plugins: {} };
    }
    if (!mergedLock.profiles[profileName]) {
      mergedLock.profiles[profileName] = { plugins: {} };
    }
    if (!ownership[profileName]) {
      ownership[profileName] = {};
    }

    const candLockProf = candidate.lock.profiles[profileName]?.plugins ?? {};

    for (const [candidateAlias, plugin] of Object.entries(candProf.plugins)) {
      // Capture derives its own alias; keep the one the manifest already uses for this package.
      const existingAlias = Object.entries(mergedManifest.profiles[profileName].plugins)
        .find(([, entry]) => entry.package === plugin.package)?.[0];
      const alias = existingAlias ?? candidateAlias;
      mergedManifest.profiles[profileName].plugins[alias] = plugin;

      const lockEntry = candLockProf[candidateAlias];
      if (lockEntry) {
        mergedLock.profiles[profileName].plugins[alias] = lockEntry;
      }

      let lockedVersion: string | undefined;
      if (plugin.source.type === 'npm') {
        lockedVersion = plugin.source.version;
      }

      ownership[profileName][plugin.package] = {
        package: plugin.package,
        alias,
        sourceType: plugin.source.type,
        lockedVersion,
        adoptedAt: now,
        adoptedBy: operationId
      };

      details.push({
        profile: profileName,
        alias,
        package: plugin.package,
        sourceType: plugin.source.type,
        version: lockedVersion
      });
    }
  }

  const lockSerialized = serializeLock(mergedLock);
  const lockHash = crypto.createHash('sha256').update(lockSerialized).digest('hex');

  const nextState: EnvironmentState = {
    apiVersion: 'dshenv-state/v1',
    lastApplied: now,
    appliedLockHash: lockHash,
    profiles: existingState.profiles ?? {},
    ownership
  };

  options?.validateManifest?.(mergedManifest);

  await writeAtomic(paths.manifestFile, serializeManifest(mergedManifest), 'overwrite');
  await writeAtomic(paths.lockFile, lockSerialized, 'overwrite');
  await writeAtomic(paths.stateFile, serializeState(nextState), 'overwrite');

  return {
    adoptedCount: details.length,
    profiles: Array.from(profilesSet),
    details,
    operationId
  };
}
