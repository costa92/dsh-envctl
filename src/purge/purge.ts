import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentManifest, EnvironmentState } from '../domain.js';
import { ValidationError } from '../errors.js';
import { acquireEnvironmentLock } from '../io/lock.js';
import { appendJournalEntry } from '../io/journal.js';
import { loadManifest, loadState } from '../manifest/files.js';
import { clearManagedPatches, profilePatchFile } from '../apply/patches.js';

export interface PurgeOptions {
  dryRun?: boolean;
  manifest?: EnvironmentManifest | null;
}

export interface PurgeResult {
  dryRun: boolean;
  profile: string;
  plugin: string;
  package: string;
  moved: string[];
  message: string;
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function assertSafeManagedPath(target: string, allowedRoot: string): Promise<void> {
  const resolved = path.resolve(target);
  if (!isPathInside(allowedRoot, resolved)) {
    throw new ValidationError(`Refusing to purge path outside allowed root: ${target}`);
  }
  const lstat = await fs.promises.lstat(resolved);
  if (lstat.isSymbolicLink()) {
    const real = await fs.promises.realpath(resolved);
    if (!isPathInside(allowedRoot, real)) {
      throw new ValidationError(`Refusing to follow symlink outside allowed root: ${target}`);
    }
  }
}

function findOwnedPlugin(
  state: EnvironmentState,
  manifest: EnvironmentManifest | null,
  profileName: string,
  pluginRef: string
): { alias: string; packageName: string } {
  const owned = state.ownership?.[profileName] ?? {};
  for (const [packageName, record] of Object.entries(owned)) {
    if (packageName === pluginRef || record.alias === pluginRef) {
      return { alias: record.alias, packageName };
    }
  }
  const plugins = manifest?.profiles[profileName]?.plugins ?? {};
  const fromManifest = plugins[pluginRef];
  if (fromManifest && owned[fromManifest.package]) {
    return { alias: pluginRef, packageName: fromManifest.package };
  }
  throw new ValidationError(`Refusing to purge '${pluginRef}' in '${profileName}': no ownership record`);
}

export async function purgePlugin(
  paths: EnvironmentPaths,
  profileName: string,
  pluginRef: string,
  options?: PurgeOptions
): Promise<PurgeResult> {
  if (!fs.existsSync(paths.stateFile)) {
    throw new ValidationError(`State file not found: ${paths.stateFile}`);
  }
  const state = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
  const manifest = options?.manifest !== undefined
    ? options.manifest
    : fs.existsSync(paths.manifestFile)
      ? loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'))
      : null;
  const owned = findOwnedPlugin(state, manifest, profileName, pluginRef);

  const moved: string[] = [];
  const patchFile = profilePatchFile(paths, profileName);
  const cloneDir = path.join(
    paths.managerDir,
    'sources',
    profileName,
    owned.packageName.replaceAll('/', '_')
  );

  if (options?.dryRun) {
    if (fs.existsSync(patchFile)) moved.push(patchFile);
    if (fs.existsSync(cloneDir)) moved.push(cloneDir);
    return {
      dryRun: true,
      profile: profileName,
      plugin: owned.alias,
      package: owned.packageName,
      moved,
      message: `Would purge managed resources for ${owned.alias}`
    };
  }

  const operationId = `purge-${Date.now().toString(16)}`;
  const trashRoot = path.join(paths.trashDir, operationId);
  const lockHandle = await acquireEnvironmentLock(paths);
  try {
    await fs.promises.mkdir(trashRoot, { recursive: true });
    await appendJournalEntry(paths, {
      operationId,
      type: 'purge-started',
      timestamp: new Date().toISOString(),
      details: { profile: profileName, package: owned.packageName }
    });

    if (fs.existsSync(patchFile)) {
      await assertSafeManagedPath(patchFile, paths.profilesDir);
      const dest = path.join(trashRoot, 'cordis.patch.yml');
      await fs.promises.copyFile(patchFile, dest);
      moved.push(dest);
      await clearManagedPatches(paths, profileName, owned.alias);
    }

    if (fs.existsSync(cloneDir)) {
      await assertSafeManagedPath(cloneDir, paths.managerDir);
      const dest = path.join(trashRoot, 'source');
      await fs.promises.rename(cloneDir, dest);
      moved.push(dest);
    }

    await appendJournalEntry(paths, {
      operationId,
      type: 'purge-completed',
      timestamp: new Date().toISOString(),
      details: { moved }
    });

    return {
      dryRun: false,
      profile: profileName,
      plugin: owned.alias,
      package: owned.packageName,
      moved,
      message: `Purged managed resources for ${owned.alias} into ${trashRoot}`
    };
  } finally {
    await lockHandle.release();
  }
}
