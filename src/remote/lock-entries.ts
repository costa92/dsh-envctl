import type { EnvironmentLock, PluginLockEntry } from '../domain.js';
import { PluginLockEntrySchema } from '../manifest/schema.js';
import { sha256Hex, type RemoteLockEntries } from './schema.js';

export interface LockEntryChanges {
  added: string[];
  modified: string[];
  removed: string[];
}

export interface LockEntryDrift {
  entry: string;
  status: 'modified' | 'missing';
}

export function lockEntryId(profile: string, alias: string): string {
  return `${profile}/${alias}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

// Ownership is per entry, so the digest must not depend on how the lock file happens to be formatted.
export function lockEntryDigest(entry: PluginLockEntry): string {
  return sha256Hex(JSON.stringify(canonical(PluginLockEntrySchema.parse(entry))));
}

export function lockEntryDigests(lock: EnvironmentLock | null): RemoteLockEntries {
  const digests: RemoteLockEntries = {};
  for (const [profile, { plugins }] of Object.entries(lock?.profiles ?? {})) {
    for (const [alias, entry] of Object.entries(plugins)) {
      (digests[profile] ??= {})[alias] = lockEntryDigest(entry);
    }
  }
  return digests;
}

function entryPairs(entries: RemoteLockEntries): Array<[string, string]> {
  return Object.entries(entries)
    .flatMap(([profile, aliases]) => Object.keys(aliases).map((alias): [string, string] => [profile, alias]))
    .sort(([pa, aa], [pb, ab]) => {
      const a = lockEntryId(pa, aa);
      const b = lockEntryId(pb, ab);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

function hasEntry(entries: RemoteLockEntries, profile: string, alias: string): boolean {
  return Object.hasOwn(entries, profile) && Object.hasOwn(entries[profile], alias);
}

function lockEntry(lock: EnvironmentLock | null, profile: string, alias: string): PluginLockEntry | undefined {
  if (!lock || !Object.hasOwn(lock.profiles, profile)) {
    return undefined;
  }
  const plugins = lock.profiles[profile].plugins;
  return Object.hasOwn(plugins, alias) ? plugins[alias] : undefined;
}

export function findLockEntryDrift(lock: EnvironmentLock | null, owned: RemoteLockEntries): LockEntryDrift[] {
  const drift: LockEntryDrift[] = [];
  for (const [profile, alias] of entryPairs(owned)) {
    const entry = lockEntry(lock, profile, alias);
    if (!entry) {
      drift.push({ entry: lockEntryId(profile, alias), status: 'missing' });
    } else if (lockEntryDigest(entry) !== owned[profile][alias]) {
      drift.push({ entry: lockEntryId(profile, alias), status: 'modified' });
    }
  }
  return drift;
}

export function findLockEntryConflicts(lock: EnvironmentLock | null, owned: RemoteLockEntries, target: RemoteLockEntries): string[] {
  return entryPairs(target)
    .filter(([profile, alias]) => lockEntry(lock, profile, alias) !== undefined && !hasEntry(owned, profile, alias))
    .map(([profile, alias]) => lockEntryId(profile, alias));
}

export function diffLockEntries(lock: EnvironmentLock | null, owned: RemoteLockEntries, target: RemoteLockEntries): LockEntryChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [profile, alias] of entryPairs(target)) {
    const digest = target[profile][alias];
    if (!hasEntry(owned, profile, alias)) {
      added.push(lockEntryId(profile, alias));
      continue;
    }
    const current = lockEntry(lock, profile, alias);
    // The second test catches entries changed locally, which only get here with --discard-local-changes.
    if (owned[profile][alias] !== digest || !current || lockEntryDigest(current) !== digest) {
      modified.push(lockEntryId(profile, alias));
    }
  }
  for (const [profile, alias] of entryPairs(owned)) {
    if (!hasEntry(target, profile, alias)) {
      removed.push(lockEntryId(profile, alias));
    }
  }
  return { added, modified, removed };
}

// New lock = local lock - entries the remote owned before + the target commit's entries; local entries stay.
export function mergeRemoteLock(
  lock: EnvironmentLock | null,
  owned: RemoteLockEntries,
  target: EnvironmentLock | null
): EnvironmentLock | null {
  const merged: EnvironmentLock = structuredClone(lock ?? { apiVersion: 'dshenv-lock/v1', profiles: {} });
  for (const [profile, alias] of entryPairs(owned)) {
    if (Object.hasOwn(merged.profiles, profile)) {
      delete merged.profiles[profile].plugins[alias];
    }
  }
  for (const [profile, { plugins }] of Object.entries(target?.profiles ?? {})) {
    for (const [alias, entry] of Object.entries(plugins)) {
      (merged.profiles[profile] ??= { plugins: {} }).plugins[alias] = structuredClone(entry);
    }
  }
  for (const profile of Object.keys(merged.profiles)) {
    if (Object.keys(merged.profiles[profile].plugins).length === 0) {
      delete merged.profiles[profile];
    }
  }
  // Never create a lock file that would hold nothing; an existing one stays, possibly empty.
  if (lock === null && Object.keys(merged.profiles).length === 0) {
    return null;
  }
  return merged;
}
