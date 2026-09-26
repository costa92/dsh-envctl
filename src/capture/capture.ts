import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentInventory } from '../inventory/profile-reader.js';
import type {
  CaptureDocument,
  EnvironmentManifest,
  EnvironmentLock,
  EnvironmentState,
  PluginManifestEntry,
  PluginLockEntry
} from '../domain.js';
import {
  serializeManifest,
  serializeLock,
  serializeState
} from '../manifest/files.js';
import { writeAtomic } from '../io/atomic-file.js';
import { ValidationError } from '../errors.js';
import { ExactVersionRegex, hasEmbeddedCredentials } from '../manifest/schema.js';

const GIT_COMMIT_RE = /^[0-9a-f]{7,40}$/i;

function parseGitSpec(spec: string): { url: string; commit?: string } {
  const hashIndex = spec.lastIndexOf('#');
  if (hashIndex <= 0) {
    return { url: spec };
  }
  const url = spec.slice(0, hashIndex);
  const fragment = spec.slice(hashIndex + 1);
  if (GIT_COMMIT_RE.test(fragment)) {
    return { url, commit: fragment };
  }
  return { url: spec };
}

function getAliasFromPackageName(pkgName: string, usedKeys: Set<string>): string {
  let base = pkgName.includes('/') ? pkgName.split('/')[1] : pkgName;
  if (base.startsWith('dsh-')) {
    base = base.slice(4);
  }
  let candidate = base;
  let counter = 1;
  while (usedKeys.has(candidate)) {
    candidate = `${base}-${counter++}`;
  }
  usedKeys.add(candidate);
  return candidate;
}

export function captureEnvironment(
  paths: EnvironmentPaths,
  inventory: EnvironmentInventory,
  options?: { profile?: string }
): CaptureDocument {
  const warnings: string[] = [];
  const manifest: EnvironmentManifest = {
    apiVersion: 'dshenv/v1',
    profiles: {}
  };
  const lock: EnvironmentLock = {
    apiVersion: 'dshenv-lock/v1',
    profiles: {}
  };

  if (options?.profile && !inventory.profiles[options.profile]) {
    throw new ValidationError(`Profile not found: ${options.profile}`);
  }

  const selectedProfiles = options?.profile
    ? { [options.profile]: inventory.profiles[options.profile] }
    : inventory.profiles;

  for (const [profileName, profileInv] of Object.entries(selectedProfiles)) {
    const profileManifestPlugins: Record<string, PluginManifestEntry> = {};
    const profileLockPlugins: Record<string, PluginLockEntry> = {};
    const usedKeys = new Set<string>();

    for (const [pkgName, plugin] of Object.entries(profileInv.plugins)) {
      if (!plugin.installed) {
        warnings.push(`Package ${pkgName} in profile ${profileName} is declared but not installed`);
      }

      const alias = getAliasFromPackageName(pkgName, usedKeys);
      const isEnabled = plugin.enabled ?? true;

      if (plugin.sourceType === 'npm') {
        const version = plugin.version || (plugin.resolvedSource && !plugin.resolvedSource.startsWith('http') ? plugin.resolvedSource : '0.0.0');
        if (!ExactVersionRegex.test(version)) {
          warnings.push(
            `Package ${pkgName} in profile ${profileName} is declared as '${version}' and not installed; skipped because dshenv needs an exact version`
          );
          continue;
        }
        const resolvedFrom =
          typeof plugin.rawPackageJson?._resolved === 'string'
            ? plugin.rawPackageJson._resolved
            : undefined;
        profileManifestPlugins[alias] = {
          package: pkgName,
          enabled: isEnabled,
          source: {
            type: 'npm',
            version
          }
        };
        profileLockPlugins[alias] = {
          package: pkgName,
          source: {
            type: 'npm',
            resolvedVersion: version,
            ...(resolvedFrom ? { resolvedFrom } : {})
          }
        };
      } else if (plugin.sourceType === 'git') {
        const parsed = parseGitSpec(plugin.resolvedSource || '');
        if (hasEmbeddedCredentials(parsed.url)) {
          warnings.push(
            `Package ${pkgName} in profile ${profileName} was skipped: its git URL embeds credentials; reinstall it over SSH or a git credential helper`
          );
          continue;
        }
        profileManifestPlugins[alias] = {
          package: pkgName,
          enabled: isEnabled,
          source: {
            type: 'git',
            url: parsed.url
          }
        };
        if (parsed.commit) {
          profileLockPlugins[alias] = {
            package: pkgName,
            source: {
              type: 'git',
              url: parsed.url,
              commit: parsed.commit
            }
          };
        } else {
          warnings.push(`Cannot lock git commit for package ${pkgName} in profile ${profileName}`);
        }
      } else if (plugin.sourceType === 'local-link') {
        const targetPath = plugin.resolvedSource || plugin.targetPath || '';
        profileManifestPlugins[alias] = {
          package: pkgName,
          enabled: isEnabled,
          source: {
            type: 'local-link',
            path: targetPath
          }
        };
        profileLockPlugins[alias] = {
          package: pkgName,
          source: {
            type: 'local-link',
            path: targetPath
          }
        };
      } else if (plugin.sourceType === 'local-file') {
        const targetPath = plugin.resolvedSource || plugin.targetPath || '';
        profileManifestPlugins[alias] = {
          package: pkgName,
          enabled: isEnabled,
          source: {
            type: 'local-file',
            path: targetPath
          }
        };
        profileLockPlugins[alias] = {
          package: pkgName,
          source: {
            type: 'local-file',
            path: targetPath
          }
        };
      } else if (plugin.sourceType === 'in-box') {
        profileManifestPlugins[alias] = {
          package: pkgName,
          enabled: isEnabled,
          source: {
            type: 'in-box'
          }
        };
        profileLockPlugins[alias] = {
          package: pkgName,
          source: {
            type: 'in-box'
          }
        };
      } else {
        warnings.push(`Missing or unknown source metadata for package ${pkgName} in profile ${profileName}`);
      }
    }

    manifest.profiles[profileName] = {
      plugins: profileManifestPlugins
    };
    lock.profiles[profileName] = {
      plugins: profileLockPlugins
    };
  }

  return {
    apiVersion: 'dshenv-capture/v1',
    manifest,
    lock,
    warnings
  };
}

export async function initEnvironment(paths: EnvironmentPaths): Promise<void> {
  const initialManifest: EnvironmentManifest = {
    apiVersion: 'dshenv/v1',
    profiles: {}
  };

  const initialLock: EnvironmentLock = {
    apiVersion: 'dshenv-lock/v1',
    profiles: {}
  };

  const initialState: EnvironmentState = {
    apiVersion: 'dshenv-state/v1',
    lastApplied: new Date().toISOString(),
    appliedLockHash: '',
    profiles: {}
  };

  await writeAtomic(paths.manifestFile, serializeManifest(initialManifest), 'create');
  await writeAtomic(paths.lockFile, serializeLock(initialLock), 'create');
  await writeAtomic(paths.stateFile, serializeState(initialState), 'create');
}
