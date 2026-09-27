import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { PatchEntry } from '../domain.js';
import { ValidationError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { withProfilePackageLock } from '../io/profile-lock.js';
import { removePatchBlock, replacePluginBlocks } from '../patch/patch.js';

const ProfileNameRegex = /^[-A-Za-z0-9._]+$/;
const MAX_PATCH_BYTES = 1024 * 1024;

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function profilePatchFile(paths: EnvironmentPaths, profileName: string): string {
  if (!ProfileNameRegex.test(profileName)) {
    throw new ValidationError(`Invalid profile name: ${profileName}`);
  }
  const profileDir = path.resolve(paths.profilesDir, profileName);
  if (!isPathInside(paths.profilesDir, profileDir)) {
    throw new ValidationError(`Profile path escapes profiles directory: ${profileName}`);
  }
  return path.join(profileDir, 'cordis.patch.yml');
}

// DSH's plugin manager rewrites cordis.patch.yml while holding the profile's package.json lock.
async function withPatchFileLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const profileDir = path.dirname(file);
  // Without a profile directory no DSH runs this profile yet, and the lock file would have nowhere to live.
  if (!fs.existsSync(profileDir)) {
    return operation();
  }
  return withProfilePackageLock(path.join(profileDir, 'package.json'), operation);
}

export async function readProfilePatchFile(paths: EnvironmentPaths, profileName: string): Promise<string> {
  const file = profilePatchFile(paths, profileName);
  if (!fs.existsSync(file)) {
    return '';
  }
  const stat = await fs.promises.stat(file);
  if (stat.size > MAX_PATCH_BYTES) {
    throw new ValidationError(`cordis.patch.yml exceeds 1 MiB: ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

export async function snapshotProfilePatchFile(
  paths: EnvironmentPaths,
  profileName: string
): Promise<() => Promise<void>> {
  const file = profilePatchFile(paths, profileName);
  const existed = fs.existsSync(file);
  const content = await readProfilePatchFile(paths, profileName);
  return () =>
    withPatchFileLock(file, async () => {
      if (existed) {
        await writeAtomic(file, content, 'overwrite');
      } else {
        await fs.promises.rm(file, { force: true });
      }
    });
}

export async function writeManagedPatches(
  paths: EnvironmentPaths,
  profileName: string,
  pluginAlias: string,
  patches: PatchEntry[]
): Promise<void> {
  const active = patches.filter((patch) => patch.enabled !== false);
  const file = profilePatchFile(paths, profileName);
  await withPatchFileLock(file, async () => {
    const content = replacePluginBlocks(await readProfilePatchFile(paths, profileName), profileName, pluginAlias, active);
    await writeAtomic(file, content.endsWith('\n') ? content : `${content}\n`, 'overwrite');
  });
}

export async function clearManagedPatches(
  paths: EnvironmentPaths,
  profileName: string,
  pluginAlias: string
): Promise<void> {
  const file = profilePatchFile(paths, profileName);
  if (!fs.existsSync(file)) {
    return;
  }
  await withPatchFileLock(file, async () => {
    const next = removePatchBlock(await readProfilePatchFile(paths, profileName), profileName, pluginAlias);
    await writeAtomic(file, next, 'overwrite');
  });
}
