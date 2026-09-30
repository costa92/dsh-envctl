import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertNotReservedKey, assertProfileName, isValidProfileName } from '../manifest/schema.js';
import { Option, type Command } from 'commander';
import { ValidationError } from '../errors.js';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../environment/paths.js';
import { resolveOverlaySelection, type OverlaySelection } from '../overlay/selection.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import { didYouMean } from './suggest.js';

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
export const LAYER_ENV = 'DSHENV_LAYER';
export const TARGET_PROFILE_HELP = `target profile (default: $${PROFILE_ENV})`;
export const WRITE_LAYER_HELP = `layer to write when an overlay is active: base or overlay (default: $${LAYER_ENV})`;
export const PROFILE_FILTER_HELP = 'only this profile (default: all)';

// The profiles the effective manifest declares; a broken manifest or overlay fails here rather than reading as none.
export function declaredProfiles(paths: EnvironmentPaths, opts: { overlay?: string | false }): string[] {
  if (!fs.existsSync(paths.manifestFile)) {
    return [];
  }
  return Object.keys(loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest.profiles).sort();
}

// The profiles DSH has created; a directory without package.json (DSH's shared node_modules) is not one.
export function createdProfiles(paths: EnvironmentPaths): string[] {
  try {
    return fs
      .readdirSync(paths.profilesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidProfileName(entry.name) && fs.existsSync(path.join(paths.profilesDir, entry.name, 'package.json')))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// Profiles to offer when none was named: those the manifest declares and those DSH has created.
function knownProfiles(paths: EnvironmentPaths, opts: { overlay?: string | false }): string[] {
  return [...new Set([...declaredProfiles(paths, opts), ...createdProfiles(paths)])].sort();
}

function knownProfilesText(names: string[]): string {
  return names.length > 0 ? `known profiles: ${names.join(', ')}` : 'no profile exists yet';
}

// A write that names a profile neither declared nor created is most likely a typo; adding one takes --new-profile.
export function assertKnownProfile(paths: EnvironmentPaths, opts: { overlay?: string | false }, profile: string, newProfile: boolean | undefined): void {
  const names = knownProfiles(paths, opts);
  // With no profile anywhere yet, the first one a fresh environment gets cannot be a typo of another.
  if (newProfile || names.length === 0 || names.includes(profile)) {
    return;
  }
  throw new ValidationError(
    `Profile '${profile}' is neither declared in the manifest nor created by DSH${didYouMean(profile, names)} (${knownProfilesText(names)}); pass --new-profile to add it as a new profile`
  );
}

// For commands that need DSH's copy of the profile: a declared one only has to be started once, anything else is a typo.
export function profileNotCreatedError(paths: EnvironmentPaths, opts: { overlay?: string | false }, profile: string): ValidationError {
  let declared: string[] = [];
  try {
    declared = declaredProfiles(paths, opts);
  } catch {
    // The profile is missing either way; the manifest error surfaces from the next command that reads it.
  }
  if (declared.includes(profile)) {
    return new ValidationError(`Profile '${profile}' is declared but DSH has not created it yet; start DSH with --profile ${profile} once`);
  }
  const names = [...new Set([...declared, ...createdProfiles(paths)])].sort();
  return new ValidationError(`Profile '${profile}' does not exist${didYouMean(profile, names)} (${knownProfilesText(names)})`);
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
const filterProfileOptions = new WeakSet<Option>();
const writeLayerOptions = new WeakSet<Option>();

// -p that narrows a report; a name no one declared or created would report an empty, healthy environment instead.
export function filterProfile(): Option {
  const option = new Option('-p, --profile <name>', PROFILE_FILTER_HELP).argParser(profileOption);
  filterProfileOptions.add(option);
  return option;
}

// -p for a command that works on one profile; defaultTargetProfile fills it in when it is left out.
export function targetProfile(): Option {
  const option = new Option('-p, --profile <name>', TARGET_PROFILE_HELP).argParser(profileOption);
  targetProfileOptions.add(option);
  return option;
}

// --layer for a command that writes the manifest; defaultTargetProfile fills it in from DSHENV_LAYER.
export function writeLayer(help = WRITE_LAYER_HELP): Option {
  const option = new Option('--layer <layer>', help);
  writeLayerOptions.add(option);
  return option;
}

function layerFromEnv(): string | undefined {
  const value = process.env[LAYER_ENV];
  if (!value) {
    return undefined;
  }
  if (value !== 'base' && value !== 'overlay') {
    throw new ValidationError(`Invalid --layer '${value}'; expected base or overlay (from ${LAYER_ENV})`);
  }
  return value;
}

// A left-out targetProfile() falls back to DSHENV_PROFILE, else fails naming the profiles to choose from; a left-out
// writeLayer() falls back to DSHENV_LAYER while an overlay is active. Either says so on stderr, as it is easy to forget.
export function defaultTargetProfile(program: Command, writeErr: (chunk: string) => void): void {
  program.hook('preAction', (_program, action) => {
    const opts = action.optsWithGlobals<{ dshHome?: string; overlay?: string | false; json?: boolean }>();
    const note = (text: string) => {
      if (!opts.json) writeErr(`${text}\n`);
    };
    const filtered = action.opts().profile;
    if (action.options.some((option) => filterProfileOptions.has(option)) && typeof filtered === 'string') {
      const names = knownProfiles(resolveCliPaths(opts), opts);
      if (!names.includes(filtered)) {
        throw new ValidationError(
          `Profile '${filtered}' is neither declared in the manifest nor created by DSH${didYouMean(filtered, names)} (${knownProfilesText(names)})`
        );
      }
    }
    if (action.options.some((option) => targetProfileOptions.has(option)) && action.opts().profile === undefined) {
      const profile = profileFromEnv();
      if (profile === undefined) {
        throw missingProfileError(resolveCliPaths(opts), opts);
      }
      action.setOptionValue('profile', profile);
      note(`Using profile '${profile}' from ${PROFILE_ENV}`);
    }
    // new and source clone write the manifest only with -p, and refuse --layer without it.
    if (action.options.some((option) => writeLayerOptions.has(option)) && action.opts().layer === undefined && action.opts().profile !== undefined) {
      if (!process.env[LAYER_ENV]) {
        return;
      }
      let overlayActive: boolean;
      try {
        overlayActive = resolveCliOverlay(opts, resolveCliPaths(opts)) !== null;
      } catch {
        // The command reports a broken overlay selection itself.
        return;
      }
      if (overlayActive) {
        const layer = layerFromEnv();
        action.setOptionValue('layer', layer);
        note(`Using layer '${layer}' from ${LAYER_ENV}`);
      } else if (process.env[LAYER_ENV] === 'overlay') {
        // A change meant for this machine must not land in the base the team shares.
        throw new ValidationError(`--layer overlay requires an active overlay (use --overlay or dshenv overlay use) (from ${LAYER_ENV})`);
      }
      // Otherwise the write goes to the base as always, so the variable has no effect.
    }
  });
}
