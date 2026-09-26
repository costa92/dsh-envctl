import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { EnvironmentManifest } from '../domain.js';
import { ValidationError } from '../errors.js';
import { PackageNameRegex } from '../manifest/schema.js';
import type { LocalSourceDigests } from '../planner/plan.js';

export interface LocalSourceInfo {
  isValid: boolean;
  name?: string;
  version?: string;
  bundleEntry?: string;
  digest: string;
  packageJson?: Record<string, unknown>;
}

export async function calculateSourceDigest(dirPath: string): Promise<string> {
  const hash = crypto.createHash('sha256');

  async function walk(current: string): Promise<string[]> {
    const entries = await fs.promises.readdir(current, { withFileTypes: true });
    const files: string[] = [];

    // Sort entries for deterministic hashing
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.git' ||
        entry.name === '.DS_Store' ||
        entry.name.startsWith('.tmp-')
      ) {
        continue;
      }
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const subFiles = await walk(fullPath);
        files.push(...subFiles);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const allFiles = await walk(dirPath);
  allFiles.sort();

  for (const file of allFiles) {
    const relative = path.relative(dirPath, file);
    hash.update(relative);
    const content = await fs.promises.readFile(file);
    hash.update(content);
  }

  return hash.digest('hex');
}

export async function inspectLocalSource(sourcePath: string): Promise<LocalSourceInfo> {
  if (!path.isAbsolute(sourcePath)) {
    throw new ValidationError(`Local source path must be absolute: ${sourcePath}`);
  }

  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
    throw new ValidationError(`Local source directory does not exist: ${sourcePath}`);
  }

  const pkgJsonPath = path.join(sourcePath, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) {
    throw new ValidationError(`Missing package.json in local source: ${sourcePath}`);
  }

  let pkgJson: Record<string, unknown>;
  try {
    pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch (err) {
    throw new ValidationError(`Invalid package.json in ${sourcePath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const name = typeof pkgJson.name === 'string' ? pkgJson.name : undefined;
  const version = typeof pkgJson.version === 'string' ? pkgJson.version : undefined;
  const bundleEntry =
    typeof (pkgJson.dsh as Record<string, unknown> | undefined)?.bundle === 'string'
      ? ((pkgJson.dsh as Record<string, unknown>).bundle as string)
      : undefined;

  const digest = await calculateSourceDigest(sourcePath);

  return {
    isValid: true,
    name,
    version,
    bundleEntry,
    digest,
    packageJson: pkgJson
  };
}

export async function readLocalSourceDigests(manifest: EnvironmentManifest | null): Promise<LocalSourceDigests> {
  const digests: LocalSourceDigests = {};
  for (const [profileName, profile] of Object.entries(manifest?.profiles ?? {})) {
    for (const [alias, plugin] of Object.entries(profile.plugins)) {
      if (plugin.source.type !== 'local-file' && plugin.source.type !== 'local-link') {
        continue;
      }
      try {
        const digest = await calculateSourceDigest(plugin.source.path);
        (digests[profileName] ??= {})[alias] = digest;
      } catch {
        // An unreadable source gives no evidence of drift; install/update will surface the error.
      }
    }
  }
  return digests;
}

// The name DSH installs the package under; directory and URL names are only a fallback.
export function readPackageJsonName(dir: string): string | undefined {
  try {
    const name: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
    return typeof name === 'string' && PackageNameRegex.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}
