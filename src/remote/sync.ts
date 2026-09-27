import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type { EnvironmentLock, EnvironmentManifest } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { createEnvironmentSnapshot, restoreEnvironmentSnapshot } from '../io/backup.js';
import { appendJournalEntry } from '../io/journal.js';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { loadState, parseOverlay, serializeLock } from '../manifest/files.js';
import { readOverlay } from '../overlay/effective.js';
import { mergeManifest } from '../overlay/merge.js';
import type { OverlaySelection } from '../overlay/selection.js';
import { buildPlan, type EnvironmentPlan } from '../planner/plan.js';
import { readLocalSourceDigests } from '../source/local.js';
import { isAncestor } from './git.js';
import {
  diffLockEntries,
  findLockEntryConflicts,
  findLockEntryDrift,
  mergeRemoteLock,
  type LockEntryChanges
} from './lock-entries.js';
import { describeRemoteDrift, findLocalDrift, localFileDigest, readLocalLock } from './ownership.js';
import { REMOTE_API_VERSION, compareRemoteKeys, remoteFilePath, writeRemoteConfig, type RemoteConfig } from './schema.js';
import { loadRemoteSnapshot, type RemoteSnapshot } from './snapshot.js';

export interface RemoteSubscription {
  url: string;
  branch: string;
  path: string;
}

export interface RemoteFileChanges {
  added: string[];
  modified: string[];
  removed: string[];
}

export interface PrepareSyncInput {
  paths: EnvironmentPaths;
  repoDir: string;
  subscription: RemoteSubscription;
  target: string;
  // null for `remote add`: nothing is owned yet.
  previous: RemoteConfig | null;
  replace?: boolean;
  discardLocalChanges?: boolean;
  selection: OverlaySelection | null;
}

export interface SyncPreview {
  status: 'up-to-date' | 'pending';
  from: string | null;
  to: string;
  files: RemoteFileChanges;
  lockEntries: LockEntryChanges;
  plan: EnvironmentPlan;
  snapshot: RemoteSnapshot;
  // The local lock with the team entries merged in; null means no lock.json is created.
  lock: EnvironmentLock | null;
  next: RemoteConfig;
}

export interface AcceptResult {
  operationId: string;
  snapshotId: string;
}

function hasChanges(changes: RemoteFileChanges | LockEntryChanges): boolean {
  return changes.added.length + changes.modified.length + changes.removed.length > 0;
}

function assertNoConflicts(input: PrepareSyncInput, snapshot: RemoteSnapshot, localLock: EnvironmentLock | null): void {
  const { paths, previous } = input;
  if (previous && !input.discardLocalChanges) {
    const drift = describeRemoteDrift(findLocalDrift(paths, previous), findLockEntryDrift(localLock, previous.lockEntries));
    if (drift.length > 0) {
      throw new ValidationError(
        `Remote-owned files and lock entries were changed locally: ${drift.join(', ')}; move the changes into a local overlay, or pass --discard-local-changes to overwrite them`
      );
    }
  }
  const ownedFiles = previous?.files ?? {};
  for (const key of Object.keys(snapshot.files).sort(compareRemoteKeys)) {
    const file = remoteFilePath(paths, key);
    if (Object.hasOwn(ownedFiles, key) || !fs.existsSync(file)) {
      continue;
    }
    if (previous) {
      throw new ValidationError(`Local file ${file} is not owned by the remote, but the remote now provides it; move it aside, then sync again`);
    }
    if (!input.replace) {
      throw new ValidationError(`Local file ${file} already exists; pass --replace to overwrite it with the remote copy (a snapshot is taken first)`);
    }
  }
  for (const entry of findLockEntryConflicts(localLock, previous?.lockEntries ?? {}, snapshot.lockEntries)) {
    if (previous) {
      throw new ValidationError(`Local lock entry '${entry}' is not owned by the remote, but the remote lock now pins it; remove the local entry, then sync again`);
    }
    if (!input.replace) {
      throw new ValidationError(`Local lock entry '${entry}' already exists; pass --replace to overwrite it with the remote entry (a snapshot is taken first)`);
    }
  }
}

function computeChanges(paths: EnvironmentPaths, owned: Record<string, string>, next: Record<string, string>): RemoteFileChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const key of Object.keys(next).sort(compareRemoteKeys)) {
    if (!Object.hasOwn(owned, key)) {
      added.push(key);
    } else if (owned[key] !== next[key] || localFileDigest(remoteFilePath(paths, key)) !== next[key]) {
      // The second test catches owned files changed locally, which only get here with --discard-local-changes.
      modified.push(key);
    }
  }
  for (const key of Object.keys(owned).sort(compareRemoteKeys)) {
    if (!Object.hasOwn(next, key)) {
      removed.push(key);
    }
  }
  return { added, modified, removed };
}

function manifestAfter(
  paths: EnvironmentPaths,
  snapshot: RemoteSnapshot,
  files: RemoteFileChanges,
  selection: OverlaySelection | null
): EnvironmentManifest {
  if (!selection) {
    return snapshot.manifest;
  }
  const key = `overlays/${selection.name}.yaml`;
  if (files.removed.includes(key)) {
    throw new ValidationError(
      `The active overlay '${selection.name}' is removed by the remote; select another overlay with dshenv overlay use, then sync again`
    );
  }
  const overlay = Object.hasOwn(snapshot.files, key)
    ? parseOverlay(snapshot.files[key].toString('utf8'), key)
    : readOverlay(paths, selection.name);
  // Every later command merges this pair, so an update that breaks the merge is refused now.
  return mergeManifest(snapshot.manifest, overlay, selection.name).manifest;
}

export async function prepareSync(input: PrepareSyncInput): Promise<SyncPreview> {
  const { paths, repoDir, subscription, target, previous } = input;
  if (previous && previous.commit !== target && !(await isAncestor(repoDir, previous.commit, target))) {
    throw new ValidationError(
      `Remote commit ${target} does not descend from the pinned commit ${previous.commit}; the remote history was rewritten or the ref is not on the subscribed history`
    );
  }
  // Read first: an unparseable lock may hold local entries, so even --discard-local-changes must not replace it.
  const localLock = readLocalLock(paths);
  const snapshot = await loadRemoteSnapshot(repoDir, target, subscription.path);
  assertNoConflicts(input, snapshot, localLock);

  const ownedEntries = previous?.lockEntries ?? {};
  const files = computeChanges(paths, previous?.files ?? {}, snapshot.digests);
  const lockEntries = diffLockEntries(localLock, ownedEntries, snapshot.lockEntries);
  const manifest = manifestAfter(paths, snapshot, files, input.selection);
  const lock = mergeRemoteLock(localLock, ownedEntries, snapshot.lock);
  const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
  const plan = buildPlan(manifest, lock, await readEnvironmentInventory(paths), state, await readLocalSourceDigests(manifest));

  const next: RemoteConfig = {
    apiVersion: REMOTE_API_VERSION,
    url: subscription.url,
    branch: subscription.branch,
    path: subscription.path,
    commit: target,
    files: snapshot.digests,
    lockEntries: snapshot.lockEntries
  };
  const unchanged = !hasChanges(files) && !hasChanges(lockEntries);
  return {
    status: previous !== null && previous.commit === target && unchanged ? 'up-to-date' : 'pending',
    from: previous?.commit ?? null,
    to: target,
    files,
    lockEntries,
    plan,
    snapshot,
    lock,
    next
  };
}

export async function acceptSync(paths: EnvironmentPaths, preview: SyncPreview): Promise<AcceptResult> {
  const operationId = `sync-${crypto.randomBytes(6).toString('hex')}`;
  // Local files a new remote overlay replaces (remote add --replace) must be restorable too.
  const overlayKeys = Object.keys(preview.snapshot.files).filter((key) => key.startsWith('overlays/'));
  const snapshot = await createEnvironmentSnapshot(paths, operationId, { overlayKeys });
  await appendJournalEntry(paths, {
    operationId,
    type: 'sync-started',
    timestamp: new Date().toISOString(),
    details: { from: preview.from, to: preview.to, files: preview.files, lockEntries: preview.lockEntries }
  });

  const created: string[] = [];
  try {
    for (const key of [...preview.files.added, ...preview.files.modified].sort(compareRemoteKeys)) {
      const file = remoteFilePath(paths, key);
      if (!fs.existsSync(file)) {
        created.push(file);
      }
      await writeAtomic(file, preview.snapshot.files[key], 'overwrite');
    }
    for (const key of preview.files.removed) {
      await fs.promises.rm(remoteFilePath(paths, key), { force: true });
    }
    // Local entries are untouched by the merge, so the lock is only rewritten when a team entry changes.
    if (preview.lock && hasChanges(preview.lockEntries)) {
      await writeAtomic(paths.lockFile, serializeLock(preview.lock), 'overwrite');
    }
    await writeRemoteConfig(paths, preview.next);
  } catch (err) {
    try {
      // The snapshot knows nothing of overlays that did not exist, so those are removed first; lock.json is restored whole.
      for (const file of created) {
        await fs.promises.rm(file, { force: true });
      }
      await restoreEnvironmentSnapshot(snapshot, paths);
      await appendJournalEntry(paths, {
        operationId,
        type: 'sync-rollback',
        timestamp: new Date().toISOString(),
        details: { reason: err instanceof Error ? err.message : String(err) }
      });
    } catch {
      // keep the original error
    }
    throw err;
  }

  await appendJournalEntry(paths, {
    operationId,
    type: 'sync-completed',
    timestamp: new Date().toISOString(),
    details: { commit: preview.to }
  });
  return { operationId, snapshotId: snapshot.snapshotId };
}
