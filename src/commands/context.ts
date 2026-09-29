import { assertNotReservedKey, assertProfileName } from '../manifest/schema.js';
import type { Command } from 'commander';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../environment/paths.js';
import { resolveOverlaySelection, type OverlaySelection } from '../overlay/selection.js';

export interface CommandContext {
  program: Command;
  writeOut: (chunk: string) => void;
  writeErr: (chunk: string) => void;
  setExitCode: (code: number) => void;
}

export function resolveCliPaths(opts: { dshHome?: string }): EnvironmentPaths {
  return resolveEnvironmentPaths({
    cliDshHome: opts.dshHome,
    envDshHome: process.env.DSH_HOME,
    cwd: process.cwd()
  });
}

export function resolveCliOverlay(opts: { overlay?: string | false }, paths: EnvironmentPaths): OverlaySelection | null {
  return resolveOverlaySelection(paths, { flag: opts.overlay, env: process.env.DSHENV_OVERLAY });
}

export function overlayBanner(selection: OverlaySelection): string {
  return `overlay: ${selection.name} (${selection.via})\n`;
}

export const profileOption = (value: string): string => assertProfileName(assertNotReservedKey('Profile name', value));
export const aliasOption = (value: string): string => assertNotReservedKey('Plugin alias', value);
