import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { PatchEntry } from '../domain.js';
import { ValidationError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { withProfilePackageLock } from '../io/profile-lock.js';
import { extractPluginBlocks, removePatchBlock, replacePluginBlocks, splicePluginBlocks } from '../patch/patch.js';

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

// What dshenv last wrote to each patch file, so a rollback can tell whether DSH has written it since.
const lastWritten = new Map<string, string>();

async function writePatchFile(file: string, content: string): Promise<void> {
  await writeAtomic(file, content, 'overwrite');
  lastWritten.set(file, content);
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

// Restores the file as it was, unless DSH wrote it after dshenv did; then only this plugin's blocks go back.
export async function snapshotProfilePatchFile(
  paths: EnvironmentPaths,
  profileName: string,
  pluginAlias: string
): Promise<() => Promise<void>> {
  const file = profilePatchFile(paths, profileName);
  const existed = fs.existsSync(file);
  const content = await readProfilePatchFile(paths, profileName);
  return () =>
    withPatchFileLock(file, async () => {
      const current = fs.existsSync(file) ? await readProfilePatchFile(paths, profileName) : null;
      const expected = lastWritten.get(file) ?? (existed ? content : null);
      if (current !== null && current !== expected) {
        const blocks = extractPluginBlocks(content, profileName, pluginAlias);
        await writePatchFile(file, splicePluginBlocks(current, profileName, pluginAlias, blocks));
      } else if (existed) {
        await writePatchFile(file, content);
      } else {
        await fs.promises.rm(file, { force: true });
        lastWritten.delete(file);
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
    await writePatchFile(file, content.endsWith('\n') ? content : `${content}\n`);
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
    await writePatchFile(file, next);
  });
}
