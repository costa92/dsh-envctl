import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentManifest, EnvironmentOverlay, OverlayPatchEntry, OverlayPluginEntry } from '../domain.js';
import { ValidationError } from '../errors.js';
import { writeAtomic } from '../io/atomic-file.js';
import { serializeOverlay } from '../manifest/files.js';
import { setAtPath } from '../config/config.js';
import { mergeManifest } from './merge.js';
import { overlayFilePath, type OverlaySelection } from './selection.js';

export type WriteLayer = 'base' | 'overlay';

export function resolveWriteLayer(selection: OverlaySelection | null, requested: string | undefined): WriteLayer {
  if (requested !== undefined && requested !== 'base' && requested !== 'overlay') {
    throw new ValidationError(`Invalid --layer '${requested}'; expected base or overlay`);
  }
  if (!selection) {
    if (requested === 'overlay') {
      throw new ValidationError('--layer overlay requires an active overlay (use --overlay or dshenv overlay use)');
    }
    return 'base';
  }
  if (requested === undefined) {
    throw new ValidationError(`Overlay '${selection.name}' is active; pass --layer base or --layer overlay`);
  }
  return requested;
}

function overlayPlugins(doc: EnvironmentOverlay, profile: string): Record<string, OverlayPluginEntry> {
  const profiles = (doc.profiles ??= {});
  const target = (profiles[profile] ??= {});
  return (target.plugins ??= {});
}

export function setOverlayPluginFields(
  doc: EnvironmentOverlay,
  profile: string,
  alias: string,
  fields: Pick<OverlayPluginEntry, 'package' | 'enabled' | 'source'>
): void {
  const plugins = overlayPlugins(doc, profile);
  const current = plugins[alias];
  plugins[alias] = { ...(current && !current.remove ? current : {}), ...fields };
}

export function setOverlayPatchValue(
  doc: EnvironmentOverlay,
  profile: string,
  alias: string,
  patchId: string,
  dottedPath: string,
  value: unknown
): OverlayPatchEntry {
  const plugins = overlayPlugins(doc, profile);
  const entry = plugins[alias] && !plugins[alias].remove ? plugins[alias] : (plugins[alias] = {});
  const patches = (entry.patches ??= []);
  const existing = patches.find((patch) => patch.id === patchId);
  const next: OverlayPatchEntry = {
    ...existing,
    id: patchId,
    config: setAtPath(existing?.config ?? {}, dottedPath, value)
  };
  entry.patches = existing ? patches.map((patch) => (patch === existing ? next : patch)) : [...patches, next];
  return next;
}

export function removeOverlayPlugin(
  doc: EnvironmentOverlay,
  base: EnvironmentManifest,
  profile: string,
  alias: string
): 'tombstoned' | 'deleted' {
  const plugins = overlayPlugins(doc, profile);
  if (base.profiles[profile]?.plugins[alias]) {
    plugins[alias] = { remove: true };
    return 'tombstoned';
  }
  if (plugins[alias]) {
    delete plugins[alias];
    return 'deleted';
  }
  throw new ValidationError(`Plugin '${alias}' not found in profile '${profile}'`);
}

// Validate against the base before writing so a bad edit never reaches the overlay file.
export async function saveOverlay(
  paths: EnvironmentPaths,
  name: string,
  base: EnvironmentManifest,
  doc: EnvironmentOverlay
): Promise<void> {
  mergeManifest(base, doc, name);
  await writeAtomic(overlayFilePath(paths, name), serializeOverlay(doc), 'overwrite');
}
