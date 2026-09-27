import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { withProfilePackageLock } from '../io/profile-lock.js';
import { PackageNameRegex } from '../manifest/schema.js';

const ProfileNameRegex = /^[-A-Za-z0-9._]+$/;

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function setProfileBundleEnabled(
  paths: EnvironmentPaths,
  profileName: string,
  packageName: string,
  enabled: boolean,
  insertAt?: number
): Promise<number> {
  if (!ProfileNameRegex.test(profileName)) {
    throw new ValidationError(`Invalid profile name: ${profileName}`);
  }
  if (!PackageNameRegex.test(packageName)) {
    throw new ValidationError(`Invalid package name: ${packageName}`);
  }

  const profileDir = path.resolve(paths.profilesDir, profileName);
  if (!isPathInside(paths.profilesDir, profileDir)) {
    throw new ValidationError(`Profile path escapes profiles directory: ${profileName}`);
  }

  const packageJsonPath = path.join(profileDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new ValidationError(`Profile package.json not found: ${packageJsonPath}`);
  }

  // DSH's HMR watches this file; its own writers hold the same lock.
  return withProfilePackageLock(packageJsonPath, async () => {
    const raw = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as unknown;
    if (!isRecord(raw)) {
      throw new ValidationError(`Profile package.json is not an object: ${packageJsonPath}`);
    }

    const dsh = isRecord(raw.dsh) ? raw.dsh : {};
    const profile = isRecord(dsh.profile) ? dsh.profile : {};
    const currentBundles = Array.isArray(profile.bundles)
      ? profile.bundles.filter((name): name is string => typeof name === 'string')
      : [];

    const previousIndex = currentBundles.indexOf(packageName);
    const nextBundles = enabled
      ? previousIndex !== -1
        ? currentBundles
        : [...currentBundles.slice(0, insertAt ?? currentBundles.length), packageName, ...currentBundles.slice(insertAt ?? currentBundles.length)]
      : currentBundles.filter((name) => name !== packageName);

    raw.dsh = {
      ...dsh,
      profile: {
        ...profile,
        bundles: nextBundles
      }
    };

    await writeAtomic(packageJsonPath, `${JSON.stringify(raw, null, 2)}\n`, 'overwrite');
    return previousIndex;
  });
}
