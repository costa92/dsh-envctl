import type { EnvironmentLock, EnvironmentManifest } from '../domain.js';
import { ValidationError } from '../errors.js';
import { loadLock, loadManifest, parseOverlay } from '../manifest/files.js';
import { mergeManifest } from '../overlay/merge.js';
import { listTree, readBlob } from './git.js';
import { lockEntryDigests, lockEntryId } from './lock-entries.js';
import { isRemoteFileKey, overlayNameFromKey, sha256Hex, type RemoteLockEntries } from './schema.js';

export interface RemoteSnapshot {
  commit: string;
  files: Record<string, Buffer>;
  digests: Record<string, string>;
  manifest: EnvironmentManifest;
  lock: EnvironmentLock | null;
  lockEntries: RemoteLockEntries;
}

const REGULAR_FILE_MODES = new Set(['100644', '100755']);

// Everything else under the path (state, selection, backups, sources, nested overlays) is machine-local and ignored.
function candidateKey(rel: string): string | null {
  if (rel === 'manifest.yaml' || rel === 'lock.json') {
    return rel;
  }
  return /^overlays\/[^/]+\.yaml$/.test(rel) ? rel : null;
}

// Local paths and their digests only mean something on the machine that recorded them.
function assertNoLocalSources(lock: EnvironmentLock): void {
  for (const [profile, { plugins }] of Object.entries(lock.profiles)) {
    for (const [alias, entry] of Object.entries(plugins)) {
      if (entry.source.type === 'local-link' || entry.source.type === 'local-file') {
        throw new ValidationError(
          `Lock entry '${lockEntryId(profile, alias)}' has a ${entry.source.type} source; a team lock cannot pin machine-local paths`
        );
      }
    }
  }
}

function withFile<T>(file: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new ValidationError(`Remote file ${file}: ${err.message}`);
    }
    throw err;
  }
}

export async function loadRemoteSnapshot(repoDir: string, commit: string, remotePath: string): Promise<RemoteSnapshot> {
  const prefix = remotePath === '.' ? '' : `${remotePath}/`;
  const files: Record<string, Buffer> = {};
  // The lock is owned per entry, so it is kept apart from the whole-file keys.
  let lockData: Buffer | null = null;
  for (const entry of await listTree(repoDir, commit, remotePath)) {
    if (!entry.path.startsWith(prefix)) {
      continue;
    }
    const key = candidateKey(entry.path.slice(prefix.length));
    if (key === null) {
      continue;
    }
    if (key !== 'lock.json' && !isRemoteFileKey(key)) {
      throw new ValidationError(`Remote overlay ${entry.path} has an invalid name (allowed: letters, digits, '.', '_', '-')`);
    }
    if (entry.type !== 'blob' || !REGULAR_FILE_MODES.has(entry.mode)) {
      throw new ValidationError(`Remote file ${entry.path} must be a regular file`);
    }
    const data = await readBlob(repoDir, commit, entry.path);
    if (key === 'lock.json') {
      lockData = data;
    } else {
      files[key] = data;
    }
  }

  const where = (key: string) => `${prefix}${key}`;
  if (!files['manifest.yaml']) {
    throw new ValidationError(`Remote commit ${commit} has no ${where('manifest.yaml')}`);
  }
  const manifest = withFile(where('manifest.yaml'), () => loadManifest(files['manifest.yaml'].toString('utf8')));
  const lockText = lockData?.toString('utf8') ?? null;
  const lock = lockText !== null
    ? withFile(where('lock.json'), () => {
        const parsed = loadLock(lockText);
        assertNoLocalSources(parsed);
        return parsed;
      })
    : null;
  for (const key of Object.keys(files)) {
    const name = overlayNameFromKey(key);
    if (name === null) {
      continue;
    }
    withFile(where(key), () => mergeManifest(manifest, parseOverlay(files[key].toString('utf8'), where(key)), name));
  }

  const digests = Object.fromEntries(Object.entries(files).map(([key, data]) => [key, sha256Hex(data)]));
  return { commit, files, digests, manifest, lock, lockEntries: lockEntryDigests(lock) };
}
