import * as fs from 'node:fs';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { EnvironmentManifest, EnvironmentOverlay, EnvironmentState } from '../domain.js';
import { ValidationError, missingManifestError } from '../errors.js';
import { loadManifest, parseOverlay } from '../manifest/files.js';
import { baseProvenance, mergeManifest, type ManifestProvenance } from './merge.js';
import { overlayFilePath, type OverlaySelection } from './selection.js';

export interface EffectiveManifest {
  manifest: EnvironmentManifest;
  provenance: ManifestProvenance;
  overlay: OverlaySelection | null;
}

export function readOverlay(paths: EnvironmentPaths, name: string): EnvironmentOverlay {
  const file = overlayFilePath(paths, name);
  if (!fs.existsSync(file)) {
    throw new ValidationError(`Overlay '${name}' not found: ${file}`);
  }
  return parseOverlay(fs.readFileSync(file, 'utf8'), file);
}

// The single entry point for commands that read the manifest; a selected overlay never silently falls back to the base.
export function loadEffectiveManifest(paths: EnvironmentPaths, selection: OverlaySelection | null): EffectiveManifest {
  if (!fs.existsSync(paths.manifestFile)) {
    throw missingManifestError(paths.manifestFile);
  }
  const base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
  if (!selection) {
    return { manifest: base, provenance: baseProvenance(base), overlay: null };
  }
  const merged = mergeManifest(base, readOverlay(paths, selection.name), selection.name);
  return { ...merged, overlay: selection };
}

export function overlaySwitchWarning(state: EnvironmentState | null, selection: OverlaySelection | null): string | null {
  if (!state) {
    return null;
  }
  const previous = state.appliedOverlay ?? 'none';
  const current = selection?.name ?? 'none';
  return previous === current ? null : `overlay changed since last apply: ${previous} → ${current}`;
}
