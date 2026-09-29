import * as fs from 'node:fs';
import * as path from 'node:path';
import { Option } from 'commander';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { getAtPath, parseConfigValue, readPluginConfig, unsetAtPath, upsertPluginPatch } from '../config/config.js';
import { loadLock, loadManifest, loadState, serializeLock } from '../manifest/files.js';
import { buildPlan } from '../planner/plan.js';
import { writeAtomic } from '../io/atomic-file.js';
import { readLocalSourceDigests } from '../source/local.js';
import { ValidationError } from '../errors.js';
import { ExactVersionRegex, PackageNameRegex } from '../manifest/schema.js';
import type { EnvironmentManifest, PluginManifestEntry, PluginSource } from '../domain.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import { removeOverlayPlugin, setOverlayPatchValue, setOverlayPluginFields } from '../overlay/write.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { OverlaySelection } from '../overlay/selection.js';
import { assertLockEntryNotRemoteOwned } from '../remote/ownership.js';
import { readRemoteConfig } from '../remote/schema.js';
import {
  resolveCliPaths,
  resolveCliOverlay,
  overlayBanner,
  profileOption,
  aliasOption,
  assertKnownProfile,
  targetProfile,
  writeLayer,
  PROFILE_FILTER_HELP,
  type CommandContext
} from './context.js';
import { didYouMean } from './suggest.js';
import { checkNpmVersion } from '../source/npm-registry.js';
import { resolveDshCommand } from '../dsh/command.js';
import { dumpProfileConfig } from '../dsh/hmr.js';
import { parseComposedProfile, pluginConfigKeys } from '../tools/catalog.js';
import { withEnvironmentLock } from '../io/lock.js';
import { resolveWrite, writeBase, writeOverlay } from './manifest-write.js';
import { readPackageJsonName } from '../source/local.js';

export interface InstallPluginRequest {
  spec: string;
  profile: string;
  alias?: string;
  packageName?: string;
  layer?: string;
  // A profile that is neither declared nor created is refused as a likely typo unless this is set.
  newProfile?: boolean;
}

export interface InstallPluginResult {
  alias: string;
  packageName: string;
  source: PluginSource;
  overlay: OverlaySelection | null;
  // The source the alias had before, when the install only moved it (to another version, say).
  previousSource?: PluginSource;
}

export interface PluginCommands {
  installPlugin: (opts: { dshHome?: string; overlay?: string | false }, request: InstallPluginRequest) => Promise<InstallPluginResult>;
}

export const NEXT_STEP = 'Next: dshenv plan, then dshenv apply --yes.';

function describeSource(source: PluginSource): string {
  switch (source.type) {
    case 'npm':
      return source.version;
    case 'git':
      return source.commit ? `${source.url}#${source.commit}` : source.url;
    case 'local-link':
    case 'local-file':
      return source.path;
    default:
      return source.type;
  }
}

// Windows paths (C:\src, \\server\share, .\src) are local there; npm and git specs never parse as absolute paths.
export function isLocalPathSpec(spec: string, pathApi: path.PlatformPath = path): boolean {
  const relative = pathApi === path.win32 ? /^\.\.?[\\/]/ : /^\.\.?\//;
  return spec.startsWith('file:') || pathApi.isAbsolute(spec) || relative.test(spec);
}

export function registerPluginCommands(ctx: CommandContext): PluginCommands {
  const { program, writeOut } = ctx;

  function parsePluginSpec(spec: string, optsAlias?: string, optsPackage?: string): { alias: string; packageName: string; source: PluginSource } {
    if (spec.startsWith('git+') || spec.startsWith('http://') || spec.startsWith('https://') || spec.startsWith('git@') || spec.endsWith('.git')) {
      const cleanUrl = spec.startsWith('git+') ? spec.slice(4) : spec;
      const urlParts = cleanUrl.split('#');
      const repoUrl = urlParts[0];
      const commitOrRef = urlParts[1];
      const baseName = path.basename(repoUrl, '.git');
      const alias = optsAlias || baseName.replace(/^(dsh-plugin-|dsh-)/, '');
      return {
        alias,
        packageName: optsPackage ?? baseName,
        source: {
          type: 'git',
          url: repoUrl,
          commit: commitOrRef
        }
      };
    }

    if (isLocalPathSpec(spec)) {
      const localPath = spec.startsWith('file:') ? spec.slice(5) : spec;
      const resolved = path.resolve(localPath);
      const baseName = path.basename(resolved);
      const alias = optsAlias || baseName.replace(/^(dsh-plugin-|dsh-)/, '');
      return {
        alias,
        packageName: optsPackage ?? readPackageJsonName(resolved) ?? baseName,
        source: {
          type: 'local-link',
          path: resolved
        }
      };
    }

    if (optsPackage !== undefined) {
      throw new ValidationError('--package only applies to git and local sources');
    }

    // A bundle that ships with DSH has no dependency: apply only selects it in the profile's bundle list.
    if (spec.startsWith('in-box:')) {
      const packageName = spec.slice('in-box:'.length);
      if (!PackageNameRegex.test(packageName)) {
        throw new ValidationError(`in-box takes a package name with no version: in-box:<package>, got '${packageName}'`);
      }
      const simpleName = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
      return { alias: optsAlias || simpleName.replace(/^(dsh-plugin-|dsh-)/, ''), packageName, source: { type: 'in-box' } };
    }

    let packageName = spec;
    let version: string | undefined;

    if (spec.startsWith('@')) {
      const atIdx = spec.indexOf('@', 1);
      if (atIdx !== -1) {
        packageName = spec.slice(0, atIdx);
        version = spec.slice(atIdx + 1);
      }
    } else {
      const atIdx = spec.indexOf('@');
      if (atIdx !== -1) {
        packageName = spec.slice(0, atIdx);
        version = spec.slice(atIdx + 1);
      }
    }

    if (!version || !ExactVersionRegex.test(version)) {
      throw new ValidationError(`npm plugin needs an exact version: ${packageName}@<x.y.z>`);
    }

    const simpleName = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
    const alias = optsAlias || simpleName.replace(/^(dsh-plugin-|dsh-)/, '');

    return {
      alias,
      packageName,
      source: {
        type: 'npm',
        version
      }
    };
  }

  function requirePlugin(manifest: EnvironmentManifest, profile: string, alias: string): PluginManifestEntry {
    const plugin = manifest.profiles[profile]?.plugins[alias];
    if (!plugin) {
      throw new ValidationError(`Plugin '${alias}' not found in profile '${profile}'`);
    }
    return plugin;
  }

  function effectivePlugin(paths: EnvironmentPaths, overlay: OverlaySelection, profile: string, alias: string): PluginManifestEntry {
    return requirePlugin(loadEffectiveManifest(paths, overlay).manifest, profile, alias);
  }

  // The alias a command names, also by its package name. A base write (`write` without an overlay) also needs the
  // alias in the base manifest, not only in the active overlay.
  function resolveAlias(
    paths: EnvironmentPaths,
    selection: OverlaySelection | null,
    profile: string,
    name: string,
    write?: { overlay: OverlaySelection | null }
  ): string {
    const manifest = loadEffectiveManifest(paths, selection).manifest;
    const declaredProfiles = Object.keys(manifest.profiles).sort();
    if (!manifest.profiles[profile]) {
      throw new ValidationError(
        `Profile '${profile}' is not declared in the manifest${didYouMean(profile, declaredProfiles)}${declaredProfiles.length > 0 ? ` (declared: ${declaredProfiles.join(', ')})` : ''}`
      );
    }
    const plugins = manifest.profiles[profile].plugins;
    const byPackage = Object.entries(plugins).filter(([, plugin]) => plugin.package === name).map(([alias]) => alias);
    const alias = name in plugins ? name : byPackage.length === 1 ? byPackage[0] : undefined;
    if (alias === undefined) {
      const aliases = Object.keys(plugins).sort();
      // A close alias is the better hint; package names only when no alias is close.
      const hint = didYouMean(name, aliases) || didYouMean(name, Object.values(plugins).map((plugin) => plugin.package));
      throw new ValidationError(`Plugin '${name}' not found in profile '${profile}'${hint}${aliases.length > 0 ? ` (aliases: ${aliases.join(', ')})` : ''}`);
    }
    if (write && !write.overlay && selection && fs.existsSync(paths.manifestFile)) {
      const base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      if (!base.profiles[profile]?.plugins[alias]) {
        throw new ValidationError(`Plugin '${alias}' is declared in overlay '${selection.name}', not in the base manifest; use --layer overlay`);
      }
    }
    return alias;
  }

  // These commands only change the manifest; the text says so and names the step that changes DSH.
  function reportWrite(
    opts: { json?: boolean },
    overlay: OverlaySelection | null,
    status: string,
    fields: Record<string, unknown>,
    text: string
  ): void {
    if (opts.json) {
      writeOut(JSON.stringify({ status, ...(overlay ? { layer: 'overlay', overlay: overlay.name } : {}), ...fields }, null, 2) + '\n');
    } else {
      writeOut(`${text} in the ${overlay ? `overlay '${overlay.name}'` : 'manifest'}. ${NEXT_STEP}\n`);
    }
  }

  async function pinLockVersion(paths: EnvironmentPaths, profile: string, alias: string, version: string): Promise<void> {
    await withEnvironmentLock(paths, async () => {
      if (!fs.existsSync(paths.lockFile)) {
        return;
      }
      const lock = loadLock(fs.readFileSync(paths.lockFile, 'utf8'));
      const lockPlugin = lock.profiles[profile]?.plugins[alias];
      if (lockPlugin?.source.type === 'npm') {
        assertLockEntryNotRemoteOwned(paths, profile, alias);
        lockPlugin.source = { ...lockPlugin.source, resolvedVersion: version };
        await writeAtomic(paths.lockFile, serializeLock(lock), 'overwrite');
      }
    });
  }

  function lockPinsNpm(paths: EnvironmentPaths, profile: string, alias: string): boolean {
    if (!fs.existsSync(paths.lockFile)) {
      return false;
    }
    return loadLock(fs.readFileSync(paths.lockFile, 'utf8')).profiles[profile]?.plugins[alias]?.source.type === 'npm';
  }

  async function installPlugin(
    opts: { dshHome?: string; overlay?: string | false; json?: boolean },
    request: InstallPluginRequest
  ): Promise<InstallPluginResult> {
    const paths = resolveCliPaths(opts);
    const { profile } = request;
    const { selection, overlay } = resolveWrite(opts, paths, request.layer, '. Run dshenv init first.');
    assertKnownProfile(paths, opts, profile, request.newProfile);
    await checkNpmSpec(opts, parsePluginSpec(request.spec, request.alias, request.packageName));

    let previousSource: PluginSource | undefined;
    const parsed = overlay
      ? await writeOverlay(paths, overlay, (doc, base) => {
          const next = parsePluginSpec(request.spec, request.alias, request.packageName);
          const baseEntry = base.profiles[profile]?.plugins[next.alias];
          if (baseEntry && baseEntry.package !== next.packageName) {
            throw new ValidationError(
              `Alias '${next.alias}' is '${baseEntry.package}' in the base manifest; an overlay cannot change its package`
            );
          }
          const overlayEntry = doc.profiles?.[profile]?.plugins?.[next.alias];
          // Reinstalling a plugin the effective manifest already has only moves its source, as in the base.
          const exists = overlayEntry ? !overlayEntry.remove : Boolean(baseEntry);
          if (exists) {
            previousSource = overlayEntry?.source ?? baseEntry?.source;
          }
          setOverlayPluginFields(doc, profile, next.alias, exists
            ? { source: next.source }
            : baseEntry
              ? { enabled: true, source: next.source }
              : { package: next.packageName, enabled: true, source: next.source });
          return next;
        })
      : await writeBase(paths, selection, (manifest) => {
          if (!manifest.profiles[profile]) {
            manifest.profiles[profile] = { plugins: {} };
          }
          const next = parsePluginSpec(request.spec, request.alias, request.packageName);
          const current = manifest.profiles[profile].plugins[next.alias];
          // Reinstalling the same package only moves its source; patches and the enabled state are kept.
          if (current?.package === next.packageName) {
            previousSource = current.source;
          }
          manifest.profiles[profile].plugins[next.alias] = current?.package === next.packageName
            ? { ...current, source: next.source }
            : { package: next.packageName, enabled: true, source: next.source };
          return next;
        });
    const moved = previousSource !== undefined && JSON.stringify(previousSource) !== JSON.stringify(parsed.source);
    return { ...parsed, overlay, ...(moved ? { previousSource } : {}) };
  }

  // A version npm does not have fails only at apply, minutes later; offline, the install goes ahead with a warning.
  async function checkNpmSpec(opts: { json?: boolean }, parsed: { packageName: string; source: PluginSource }): Promise<void> {
    if (parsed.source.type !== 'npm' || process.env.DSHENV_NPM_CHECK === 'off') {
      return;
    }
    const check = await checkNpmVersion(parsed.packageName, parsed.source.version);
    if (check.status === 'missing') {
      throw new ValidationError(
        check.what === 'package'
          ? `npm has no package ${parsed.packageName}`
          : `npm has no version ${parsed.source.version} of ${parsed.packageName}${check.latest ? `; the latest is ${check.latest}` : ''}`
      );
    }
    if (check.status === 'unknown' && !opts.json) {
      ctx.writeErr(`Could not check ${parsed.packageName}@${parsed.source.version} on npm (${check.reason}); apply fails if it does not exist\n`);
    }
  }

  program
    .command('install <spec>')
    .description('Add a plugin to the manifest for a profile (apply installs it)')
    .addOption(targetProfile())
    .option('--as <alias>', 'custom alias name for the plugin', aliasOption)
    .option('--package <name>', 'package name for a git or local source; defaults to its package.json name')
    .addOption(writeLayer())
    .option('--new-profile', 'allow a profile that is neither declared nor created yet (guards against typos)')
    .action(async (spec: string, cmdOpts) => {
      const opts = program.opts();
      const result = await installPlugin(opts, {
        spec,
        profile: cmdOpts.profile,
        alias: cmdOpts.as,
        packageName: cmdOpts.package,
        layer: cmdOpts.layer,
        newProfile: cmdOpts.newProfile
      });
      reportWrite(
        opts,
        result.overlay,
        'installed',
        { profile: cmdOpts.profile, alias: result.alias, package: result.packageName, source: result.source },
        result.previousSource
          ? `Changed ${result.alias} in profile '${cmdOpts.profile}' from ${describeSource(result.previousSource)} to ${describeSource(result.source)}`
          : `Added ${result.packageName} (${result.alias}) to profile '${cmdOpts.profile}'`
      );
    });

  program
    .command('update <alias>')
    .description('Update the declared npm version for a plugin in the manifest')
    .addOption(targetProfile())
    .requiredOption('--to <version>', 'exact version to declare; does not float to latest')
    .addOption(writeLayer())
    .action(async (name: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (!ExactVersionRegex.test(cmdOpts.to)) {
        throw new ValidationError('--to must be an exact version such as 1.2.3');
      }
      const profile: string = cmdOpts.profile;
      const version: string = cmdOpts.to;
      const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
      const alias = resolveAlias(paths, selection, profile, name, { overlay });
      // The lock pin runs after the manifest write, so a team-pinned entry must be refused before anything is written.
      // Skip the lock read entirely when unsubscribed, so a corrupt lock.json still fails where it always did.
      if (readRemoteConfig(paths) && lockPinsNpm(paths, profile, alias)) {
        assertLockEntryNotRemoteOwned(paths, profile, alias);
      }
      const npmOnly = (type: string) => new ValidationError(`update --to currently supports npm sources only (got ${type})`);

      if (overlay) {
        await writeOverlay(paths, overlay, (doc) => {
          const plugin = effectivePlugin(paths, overlay, profile, alias);
          if (plugin.source.type !== 'npm') {
            throw npmOnly(plugin.source.type);
          }
          setOverlayPluginFields(doc, profile, alias, { source: { ...plugin.source, version } });
        });
      } else {
        await writeBase(paths, selection, (manifest) => {
          const plugin = requirePlugin(manifest, profile, alias);
          if (plugin.source.type !== 'npm') {
            throw npmOnly(plugin.source.type);
          }
          plugin.source = { ...plugin.source, version };
        });
      }
      await pinLockVersion(paths, profile, alias, version);
      reportWrite(opts, overlay, 'updated', { profile, alias, version }, `Set ${alias} in profile '${profile}' to ${version}`);
    });

  program
    .command('list')
    .description('List declared and unmanaged plugins')
    .option('-p, --profile <name>', PROFILE_FILTER_HELP, profileOption)
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const selection = resolveCliOverlay(opts, paths);
      const { manifest, provenance } = loadEffectiveManifest(paths, selection);
      const lock = fs.existsSync(paths.lockFile) ? loadLock(fs.readFileSync(paths.lockFile, 'utf8')) : null;
      const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
      const inventory = await readEnvironmentInventory(paths);
      const plan = buildPlan(manifest, lock, inventory, state, await readLocalSourceDigests(manifest));
      const rows: Array<Record<string, unknown>> = [];
      const profiles = cmdOpts.profile ? [cmdOpts.profile] : Object.keys(manifest.profiles);
      for (const profileName of profiles) {
        const declared = manifest.profiles[profileName]?.plugins ?? {};
        for (const [alias, plugin] of Object.entries(declared)) {
          const installed = inventory.profiles[profileName]?.plugins[plugin.package];
          rows.push({
            profile: profileName,
            alias,
            package: plugin.package,
            enabled: plugin.enabled ?? true,
            source: plugin.source.type,
            installed: Boolean(installed?.installed),
            actualVersion: installed?.version,
            origin: provenance[profileName]?.[alias]?.origin ?? null
          });
        }
      }
      for (const unmanaged of plan.unmanaged) {
        if (cmdOpts.profile && unmanaged.profile !== cmdOpts.profile) {
          continue;
        }
        rows.push({
          profile: unmanaged.profile,
          alias: null,
          package: unmanaged.package,
          enabled: inventory.profiles[unmanaged.profile]?.plugins[unmanaged.package]?.enabled,
          source: 'unmanaged',
          installed: true,
          origin: null
        });
      }
      if (opts.json) {
        writeOut(JSON.stringify(selection ? { plugins: rows, overlay: selection } : { plugins: rows }, null, 2) + '\n');
      } else {
        if (selection) {
          writeOut(overlayBanner(selection));
        }
        for (const row of rows) {
          const origin = selection ? ` origin=${String(row.origin ?? '-')}` : '';
          writeOut(`${row.profile} ${row.alias ?? '-'} ${row.package} ${row.source} installed=${String(row.installed)}${origin}\n`);
        }
      }
    });

  // Where DSH composes a default config for the package, a key it does not have is most likely a typo.
  async function assertKnownConfigKey(paths: EnvironmentPaths, opts: { harnessSource?: string; overlay?: string | false }, profile: string, packageName: string, dottedPath: string): Promise<void> {
    // dsh --dump-config creates a missing profile, which a manifest write must not do.
    if (!fs.existsSync(path.join(paths.profilesDir, profile, 'package.json'))) {
      return;
    }
    const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
    const command = resolveDshCommand({ cliHarnessSource: opts.harnessSource, manifestHarnessSource: manifest.environment?.harness?.sourceDir });
    if (!command) {
      return;
    }
    const dump = await dumpProfileConfig(profile, { command, dshHome: paths.home });
    if (!dump.ok) {
      return;
    }
    let keys: string[];
    try {
      keys = pluginConfigKeys(parseComposedProfile(dump.yaml), packageName);
    } catch {
      return;
    }
    const head = dottedPath.split('.')[0];
    if (keys.length > 0 && !keys.includes(head)) {
      throw new ValidationError(
        `'${head}' is not a config key of ${packageName}${didYouMean(head, keys)} (DSH composes: ${keys.join(', ')}); pass --force to set it anyway`
      );
    }
  }

  const configCmd = program.command('config').description('Read or update declared plugin configuration');
  configCmd
    .command('get <alias> [dottedPath]')
    .description("Show a plugin's config (live if applied, else as declared), or one key of it")
    .addOption(targetProfile())
    // Superseded by the positional dottedPath, the spelling config set and tools config use.
    .addOption(new Option('--path <dottedPath>').hideHelp())
    .action(async (name: string, dottedPath: string | undefined, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (dottedPath !== undefined && cmdOpts.path !== undefined) {
        throw new ValidationError('Give the config path once: as the argument or with --path, not both');
      }
      const selection = resolveCliOverlay(opts, paths);
      const alias = resolveAlias(paths, selection, cmdOpts.profile, name);
      const manifest = loadEffectiveManifest(paths, selection).manifest;
      const config = await readPluginConfig(paths, manifest, cmdOpts.profile, alias);
      const field = dottedPath ?? cmdOpts.path;
      const value = field ? getAtPath(config.config, field) : config;
      if (value === undefined) {
        throw new ValidationError(
          `The config of '${alias}' in profile '${cmdOpts.profile}' has no '${field}'${didYouMean(field!.split('.')[0], Object.keys(config.config))}`
        );
      }
      writeOut(`${JSON.stringify(value, null, 2)}\n`);
    });
  configCmd
    .command('validate <alias>')
    .description("Check that a plugin's live config patch still matches what dshenv wrote")
    .addOption(targetProfile())
    .action(async (name: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const selection = resolveCliOverlay(opts, paths);
      const alias = resolveAlias(paths, selection, cmdOpts.profile, name);
      const manifest = loadEffectiveManifest(paths, selection).manifest;
      const config = await readPluginConfig(paths, manifest, cmdOpts.profile, alias);
      const ok = config.source === 'manifest' || config.digestValid === true;
      if (opts.json) {
        writeOut(JSON.stringify({ alias, profile: cmdOpts.profile, valid: ok, source: config.source, digest: config.digest }, null, 2) + '\n');
      } else {
        writeOut(`${ok ? 'valid' : 'invalid'} (${config.source})\n`);
      }
      if (!ok) {
        throw new ValidationError(`Config digest mismatch for ${alias} in ${cmdOpts.profile}`);
      }
    });
  configCmd
    .command('set <alias> <dottedPath> <value>')
    .description('Set one key of a plugin config patch in the manifest (the value is parsed as JSON, else taken as a string)')
    .addOption(targetProfile())
    .addOption(writeLayer())
    .option('--force', 'set a key DSH does not compose for this plugin')
    .action(async (name: string, dottedPath: string, value: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const profile: string = cmdOpts.profile;
      const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
      const alias = resolveAlias(paths, selection, profile, name, { overlay });
      if (!cmdOpts.force) {
        const plugin = loadEffectiveManifest(paths, selection).manifest.profiles[profile].plugins[alias];
        await assertKnownConfigKey(paths, opts, profile, plugin.package, dottedPath);
      }

      const patch = overlay
        ? await writeOverlay(paths, overlay, (doc) => {
            const plugin = effectivePlugin(paths, overlay, profile, alias);
            return setOverlayPatchValue(doc, profile, alias, plugin.patches?.[0]?.id ?? alias, dottedPath, parseConfigValue(value));
          })
        : await writeBase(paths, selection, (manifest) =>
            upsertPluginPatch(manifest, profile, alias, dottedPath, parseConfigValue(value))
          );

      reportWrite(opts, overlay, 'set', { profile, alias, path: dottedPath, patch }, `Set ${alias} config ${dottedPath} in profile '${profile}'`);
    });
  configCmd
    .command('unset <alias> <dottedPath>')
    .description('Remove one key from a plugin config patch in the manifest')
    .addOption(targetProfile())
    .addOption(writeLayer())
    .action(async (name: string, dottedPath: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const profile: string = cmdOpts.profile;
      const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
      const alias = resolveAlias(paths, selection, profile, name, { overlay });
      const missing = (where: string) => new ValidationError(`The config of '${alias}' in ${where} has no '${dottedPath}'`);

      if (overlay) {
        await writeOverlay(paths, overlay, (doc, base) => {
          const entry = doc.profiles?.[profile]?.plugins?.[alias];
          const removed = Boolean(entry && !entry.remove && entry.patches?.some((patch) => patch.config && unsetAtPath(patch.config, dottedPath)));
          if (!removed) {
            // Overlay patches merge into the base ones, so a key the base sets cannot be taken out from the overlay.
            if (base.profiles[profile]?.plugins[alias]?.patches?.some((patch) => getAtPath(patch.config, dottedPath) !== undefined)) {
              throw new ValidationError(`'${dottedPath}' of '${alias}' is set in the base manifest, which an overlay cannot remove; use --layer base`);
            }
            throw missing(`overlay '${overlay.name}'`);
          }
        });
      } else {
        await writeBase(paths, selection, (manifest) => {
          const patch = requirePlugin(manifest, profile, alias).patches?.[0];
          if (!patch || !unsetAtPath(patch.config, dottedPath)) {
            throw missing(`profile '${profile}'`);
          }
        });
      }
      reportWrite(opts, overlay, 'unset', { profile, alias, path: dottedPath }, `Removed ${alias} config ${dottedPath} in profile '${profile}'`);
    });

  for (const toggle of [
    { name: 'enable', description: 'Enable a plugin in the manifest (apply enables it in DSH)', enabled: true, status: 'enabled', verb: 'Enabled' },
    { name: 'disable', description: 'Disable a plugin in the manifest (apply disables it in DSH)', enabled: false, status: 'disabled', verb: 'Disabled' }
  ]) {
    program
      .command(`${toggle.name} <alias>`)
      .description(toggle.description)
      .addOption(targetProfile())
      .addOption(writeLayer())
      .action(async (name: string, cmdOpts) => {
        const opts = program.opts();
        const paths = resolveCliPaths(opts);
        const profile: string = cmdOpts.profile;
        const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
        const alias = resolveAlias(paths, selection, profile, name, { overlay });

        if (overlay) {
          await writeOverlay(paths, overlay, (doc) => {
            effectivePlugin(paths, overlay, profile, alias);
            setOverlayPluginFields(doc, profile, alias, { enabled: toggle.enabled });
          });
        } else {
          await writeBase(paths, selection, (manifest) => {
            requirePlugin(manifest, profile, alias).enabled = toggle.enabled;
          });
        }
        reportWrite(opts, overlay, toggle.status, { profile, alias }, `${toggle.verb} plugin '${alias}' in profile '${profile}'`);
      });
  }

  program
    .command('remove <alias>')
    .description('Remove a plugin from the manifest (apply uninstalls it)')
    .addOption(targetProfile())
    .option('-y, --yes', 'skip confirmation')
    .addOption(writeLayer())
    .action(async (name: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const profile: string = cmdOpts.profile;
      const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
      const alias = resolveAlias(paths, selection, profile, name, { overlay });

      if (overlay) {
        const outcome = await writeOverlay(paths, overlay, (doc, base) => removeOverlayPlugin(doc, base, profile, alias));
        reportWrite(opts, overlay, 'removed', { profile, alias, outcome }, `Removed plugin '${alias}' from profile '${profile}'`);
        return;
      }
      await writeBase(paths, selection, (manifest) => {
        requirePlugin(manifest, profile, alias);
        delete manifest.profiles[profile].plugins[alias];
      });
      reportWrite(opts, null, 'removed', { profile, alias }, `Removed plugin '${alias}' from profile '${profile}'`);
    });

  return { installPlugin };
}
