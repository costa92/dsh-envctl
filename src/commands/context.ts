import * as fs from 'node:fs';
import { assertNotReservedKey, assertProfileName, isValidProfileName } from '../manifest/schema.js';
import { Option, type Command } from 'commander';
import { ValidationError } from '../errors.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../environment/paths.js';
import { resolveOverlaySelection, type OverlaySelection } from '../overlay/selection.js';
import { loadEffectiveManifest } from '../overlay/effective.js';

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

export const PROFILE_ENV = 'DSHENV_PROFILE';
export const TARGET_PROFILE_HELP = `target profile (default: $${PROFILE_ENV})`;
export const PROFILE_FILTER_HELP = 'only this profile (default: all)';

// Profiles to offer when none was named: those the manifest declares and those DSH has created.
function knownProfiles(paths: EnvironmentPaths, opts: { overlay?: string | false }): string[] {
  const names = new Set<string>();
  try {
    for (const name of Object.keys(loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest.profiles)) {
      names.add(name);
    }
  } catch {
    // No readable manifest: offer what DSH has.
  }
  try {
    for (const entry of fs.readdirSync(paths.profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && isValidProfileName(entry.name)) {
        names.add(entry.name);
      }
    }
  } catch {
    // No profiles directory yet.
  }
  return [...names].sort();
}

export function profileFromEnv(): string | undefined {
  const value = process.env[PROFILE_ENV];
  if (!value) {
    return undefined;
  }
  try {
    return profileOption(value);
  } catch (err) {
    throw new ValidationError(`${err instanceof Error ? err.message : String(err)} (from ${PROFILE_ENV})`);
  }
}

export function missingProfileError(paths: EnvironmentPaths, opts: { overlay?: string | false }): ValidationError {
  const names = knownProfiles(paths, opts);
  return new ValidationError(
    names.length > 0
      ? `Missing -p, --profile <name>: choose one of ${names.join(', ')}, or set ${PROFILE_ENV}`
      : `Missing -p, --profile <name>: no profile exists yet; pass -p <name> or set ${PROFILE_ENV}`
  );
}

const targetProfileOptions = new WeakSet<Option>();

// -p for a command that works on one profile; defaultTargetProfile fills it in when it is left out.
export function targetProfile(): Option {
  const option = new Option('-p, --profile <name>', TARGET_PROFILE_HELP).argParser(profileOption);
  targetProfileOptions.add(option);
  return option;
}

// A left-out targetProfile() falls back to DSHENV_PROFILE, else fails naming the profiles to choose from.
export function defaultTargetProfile(program: Command): void {
  program.hook('preAction', (_program, action) => {
    if (!action.options.some((option) => targetProfileOptions.has(option)) || action.opts().profile !== undefined) {
      return;
    }
    const opts = action.optsWithGlobals<{ dshHome?: string; overlay?: string | false }>();
    const profile = profileFromEnv();
    if (profile === undefined) {
      throw missingProfileError(resolveCliPaths(opts), opts);
    }
    action.setOptionValue('profile', profile);
  });
}
