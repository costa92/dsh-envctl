import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentManifest, PatchEntry } from '../domain.js';
import { ValidationError } from '../errors.js';
import { computePatchDigest, extractManagedPatches } from '../patch/patch.js';
import { readProfilePatchFile } from '../apply/patches.js';

export function parseConfigValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export function setAtPath(target: Record<string, unknown>, dottedPath: string, value: unknown): Record<string, unknown> {
  if (!dottedPath.trim() || dottedPath.split('.').some((part) => part.length === 0)) {
    throw new ValidationError(`Invalid config path: ${dottedPath}`);
  }
  const parts = dottedPath.split('.');
  const next: Record<string, unknown> = { ...target };
  let cursor: Record<string, unknown> = next;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    if (i === parts.length - 1) {
      cursor[key] = value;
      break;
    }
    const child = cursor[key];
    const copy = child && typeof child === 'object' && !Array.isArray(child)
      ? { ...(child as Record<string, unknown>) }
      : {};
    cursor[key] = copy;
    cursor = copy;
  }
  return next;
}

export function getAtPath(target: Record<string, unknown>, dottedPath: string): unknown {
  const parts = dottedPath.split('.');
  let cursor: unknown = target;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor) || !(part in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export async function readPluginConfig(
  paths: EnvironmentPaths,
  manifest: EnvironmentManifest,
  profileName: string,
  alias: string
): Promise<{ source: 'live' | 'manifest'; id: string; config: Record<string, unknown>; digest?: string; digestValid?: boolean }> {
  const plugin = manifest.profiles[profileName]?.plugins[alias];
  if (!plugin) {
    throw new ValidationError(`Plugin '${alias}' not found in profile '${profileName}'`);
  }

  const live = extractManagedPatches(await readProfilePatchFile(paths, profileName), profileName)
    .find((patch) => patch.plugin === alias);
  if (live) {
    return {
      source: 'live',
      id: live.id ?? alias,
      config: live.config,
      digest: live.digest,
      digestValid: live.isDigestValid
    };
  }

  const declared = plugin.patches?.[0];
  return {
    source: 'manifest',
    id: declared?.id ?? alias,
    config: declared?.config ?? {},
    digest: declared ? computePatchDigest(declared.config) : undefined,
    digestValid: declared ? true : undefined
  };
}

export function upsertPluginPatch(
  manifest: EnvironmentManifest,
  profileName: string,
  alias: string,
  dottedPath: string,
  value: unknown
): PatchEntry {
  const plugin = manifest.profiles[profileName]?.plugins[alias];
  if (!plugin) {
    throw new ValidationError(`Plugin '${alias}' not found in profile '${profileName}'`);
  }
  const current: PatchEntry = plugin.patches?.[0] ?? { id: alias, config: {} };
  const config = setAtPath(current.config, dottedPath, value);
  const next: PatchEntry = { ...current, config };
  plugin.patches = [next, ...(plugin.patches?.slice(1) ?? [])];
  return next;
}
