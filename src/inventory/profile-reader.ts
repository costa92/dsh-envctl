import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { SourceType } from '../domain.js';
import { PackageNameRegex } from '../manifest/schema.js';

export interface InstalledPluginInfo {
  name: string;
  installed: boolean;
  version?: string;
  sourceType: SourceType;
  resolvedSource?: string;
  isSymlink: boolean;
  isExternalSymlink: boolean;
  targetPath?: string;
  rawPackageJson?: Record<string, unknown>;
  enabled?: boolean;
}

export interface ProfileInventory {
  name: string;
  path: string;
  plugins: Record<string, InstalledPluginInfo>;
  rawProfile?: Record<string, unknown>;
}

export interface EnvironmentInventory {
  profiles: Record<string, ProfileInventory>;
}

const MAX_JSON_SIZE = 1024 * 1024; // 1 MiB

function safeReadJson(filePath: string): unknown | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_JSON_SIZE) {
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function classifySource(
  isSymlink: boolean,
  isExternalSymlink: boolean,
  targetPath: string | undefined,
  pkgJson: Record<string, unknown> | null
): { sourceType: SourceType; resolvedSource?: string } {
  if (isSymlink || isExternalSymlink) {
    if (targetPath) {
      try {
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
          return { sourceType: 'local-link', resolvedSource: targetPath };
        }
        return { sourceType: 'local-file', resolvedSource: targetPath };
      } catch {
        return { sourceType: 'local-link', resolvedSource: targetPath };
      }
    }
    return { sourceType: 'local-link' };
  }

  if (pkgJson) {
    const resolved = (pkgJson._resolved as string) || (pkgJson._from as string) || '';
    if (resolved.startsWith('git+') || resolved.startsWith('git://') || resolved.includes('github.com')) {
      return { sourceType: 'git', resolvedSource: resolved };
    }
    if (resolved.startsWith('file:')) {
      return { sourceType: 'local-file', resolvedSource: resolved };
    }
    if (pkgJson.version && typeof pkgJson.version === 'string') {
      return { sourceType: 'npm', resolvedSource: resolved || undefined };
    }
  }

  return { sourceType: 'unknown' };
}

export async function readEnvironmentInventory(
  paths: EnvironmentPaths
): Promise<EnvironmentInventory> {
  const result: EnvironmentInventory = {
    profiles: {}
  };

  if (!fs.existsSync(paths.profilesDir)) {
    return result;
  }

  const entries = await fs.promises.readdir(paths.profilesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const profileName = entry.name;
    const profilePath = path.join(paths.profilesDir, profileName);
    const profileJsonPath = path.join(profilePath, 'profile.json');

    let rawProfile: Record<string, unknown> | undefined;
    const profileData = safeReadJson(profileJsonPath);
    if (profileData && typeof profileData === 'object') {
      rawProfile = profileData as Record<string, unknown>;
    }

    const plugins: Record<string, InstalledPluginInfo> = {};

    // 1. Check profile.json declared plugins
    if (rawProfile && rawProfile.plugins && typeof rawProfile.plugins === 'object') {
      for (const [key, val] of Object.entries(rawProfile.plugins)) {
        if (!PackageNameRegex.test(key)) continue;
        const isEnabled = typeof val === 'object' && val !== null ? (val as { enabled?: boolean }).enabled ?? true : true;
        plugins[key] = {
          name: key,
          installed: false,
          sourceType: 'unknown',
          isSymlink: false,
          isExternalSymlink: false,
          enabled: isEnabled
        };
      }
    }

    // 2. Discover node_modules packages
    const nodeModulesPath = path.join(profilePath, 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
      await scanNodeModules(nodeModulesPath, profilePath, plugins);
    }

    result.profiles[profileName] = {
      name: profileName,
      path: profilePath,
      plugins,
      rawProfile
    };
  }

  return result;
}

async function scanNodeModules(
  nodeModulesDir: string,
  profileDir: string,
  plugins: Record<string, InstalledPluginInfo>
): Promise<void> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fs.promises.readdir(nodeModulesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    if (entry.name.startsWith('@')) {
      // Scoped package directory
      const scopeDir = path.join(nodeModulesDir, entry.name);
      let scopeEntries: fs.Dirent[] = [];
      try {
        scopeEntries = await fs.promises.readdir(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const sub of scopeEntries) {
        if (sub.name.startsWith('.')) continue;
        const pkgName = `${entry.name}/${sub.name}`;
        if (!PackageNameRegex.test(pkgName)) continue;
        const pkgPath = path.join(scopeDir, sub.name);
        await inspectPackage(pkgName, pkgPath, profileDir, plugins);
      }
    } else {
      const pkgName = entry.name;
      if (!PackageNameRegex.test(pkgName)) continue;
      const pkgPath = path.join(nodeModulesDir, pkgName);
      await inspectPackage(pkgName, pkgPath, profileDir, plugins);
    }
  }
}

async function inspectPackage(
  pkgName: string,
  pkgPath: string,
  profileDir: string,
  plugins: Record<string, InstalledPluginInfo>
): Promise<void> {
  try {
    const lstat = await fs.promises.lstat(pkgPath);
    let isSymlink = lstat.isSymbolicLink();
    let isExternalSymlink = false;
    let targetPath: string | undefined;

    if (isSymlink) {
      try {
        targetPath = await fs.promises.realpath(pkgPath);
        // Check if target is outside profileDir
        const relative = path.relative(profileDir, targetPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          isExternalSymlink = true;
        }
      } catch {
        // broken symlink
      }
    }

    const packageJsonPath = path.join(pkgPath, 'package.json');
    const pkgJson = safeReadJson(packageJsonPath) as Record<string, unknown> | null;
    const version = pkgJson?.version && typeof pkgJson.version === 'string' ? pkgJson.version : undefined;

    const { sourceType, resolvedSource } = classifySource(
      isSymlink,
      isExternalSymlink,
      targetPath,
      pkgJson
    );

    const existing = plugins[pkgName];
    plugins[pkgName] = {
      name: pkgName,
      installed: true,
      version,
      sourceType,
      resolvedSource,
      isSymlink,
      isExternalSymlink,
      targetPath,
      rawPackageJson: pkgJson || undefined,
      enabled: existing?.enabled ?? true
    };
  } catch {
    // ignore read failures
  }
}
