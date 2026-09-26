import * as fs from 'node:fs';
import * as path from 'node:path';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { getAtPath, parseConfigValue, readPluginConfig, upsertPluginPatch } from '../config/config.js';
import { loadManifest, loadLock, loadState, serializeLock, serializeManifest } from '../manifest/files.js';
import { buildPlan } from '../planner/plan.js';
import { writeAtomic } from '../io/atomic-file.js';
import { readLocalSourceDigests } from '../source/local.js';
import { ValidationError } from '../errors.js';
import { ExactVersionRegex } from '../manifest/schema.js';
import type { EnvironmentManifest, EnvironmentOverlay, PluginManifestEntry, PluginSource } from '../domain.js';
import { loadEffectiveManifest, readOverlay } from '../overlay/effective.js';
import { assertBaseMergesWithOverlay, removeOverlayPlugin, resolveWriteLayer, saveOverlay, setOverlayPatchValue, setOverlayPluginFields } from '../overlay/write.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import type { OverlaySelection } from '../overlay/selection.js';
import { resolveCliPaths, resolveCliOverlay, overlayBanner, profileOption, aliasOption, type CommandContext } from './context.js';
import { withEnvironmentLock } from '../io/lock.js';
import { readPackageJsonName } from '../source/local.js';

export function registerPluginCommands(ctx: CommandContext): void {
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

    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || spec.startsWith('file:')) {
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

  // Resolves which layer a manifest write goes to; `overlay` is set only when writing the active overlay.
  function resolveWrite(
    opts: { overlay?: string | false },
    paths: EnvironmentPaths,
    layerOption: string | undefined,
    missingHint = ''
  ): { selection: OverlaySelection | null; overlay: OverlaySelection | null } {
    if (!fs.existsSync(paths.manifestFile)) {
      throw new ValidationError(`Manifest file not found: ${paths.manifestFile}${missingHint}`);
    }
    const selection = resolveCliOverlay(opts, paths);
    return { selection, overlay: resolveWriteLayer(selection, layerOption) === 'overlay' ? selection : null };
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

  async function writeOverlay<T>(
    paths: EnvironmentPaths,
    overlay: OverlaySelection,
    edit: (doc: EnvironmentOverlay, base: EnvironmentManifest) => T
  ): Promise<T> {
    return withEnvironmentLock(paths, async () => {
      const base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      const doc = readOverlay(paths, overlay.name);
      const result = edit(doc, base);
      await saveOverlay(paths, overlay.name, base, doc);
      return result;
    });
  }

  async function writeBase<T>(
    paths: EnvironmentPaths,
    selection: OverlaySelection | null,
    edit: (manifest: EnvironmentManifest) => T
  ): Promise<T> {
    return withEnvironmentLock(paths, async () => {
      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      const result = edit(manifest);
      assertBaseMergesWithOverlay(paths, selection, manifest);
      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');
      return result;
    });
  }

  function reportWrite(
    opts: { json?: boolean },
    overlay: OverlaySelection | null,
    status: string,
    fields: Record<string, unknown>,
    text: string,
    textTail = ''
  ): void {
    if (opts.json) {
      writeOut(JSON.stringify({ status, ...(overlay ? { layer: 'overlay', overlay: overlay.name } : {}), ...fields }, null, 2) + '\n');
    } else {
      writeOut(`${text}${overlay ? ` (overlay '${overlay.name}')` : ''}.${textTail}\n`);
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
        lockPlugin.source = { ...lockPlugin.source, resolvedVersion: version };
        await writeAtomic(paths.lockFile, serializeLock(lock), 'overwrite');
      }
    });
  }

  program
    .command('install <spec>')
    .description('Install a plugin into the manifest for a profile')
    .requiredOption('-p, --profile <name>', 'target profile', profileOption)
    .option('--as <alias>', 'custom alias name for the plugin', aliasOption)
    .option('--package <name>', 'package name for a git or local source; defaults to its package.json name')
    .option('--layer <layer>', 'layer to write when an overlay is active: base or overlay')
    .action(async (spec: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const profile: string = cmdOpts.profile;
      const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer, '. Run dshenv init first.');

      const parsed = overlay
        ? await writeOverlay(paths, overlay, (doc, base) => {
            const next = parsePluginSpec(spec, cmdOpts.as, cmdOpts.package);
            const baseEntry = base.profiles[profile]?.plugins[next.alias];
            if (baseEntry && baseEntry.package !== next.packageName) {
              throw new ValidationError(
                `Alias '${next.alias}' is '${baseEntry.package}' in the base manifest; an overlay cannot change its package`
              );
            }
            const overlayEntry = doc.profiles?.[profile]?.plugins?.[next.alias];
            // Reinstalling a plugin the effective manifest already has only moves its source, as in the base.
            const exists = overlayEntry ? !overlayEntry.remove : Boolean(baseEntry);
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
            const next = parsePluginSpec(spec, cmdOpts.as, cmdOpts.package);
            const current = manifest.profiles[profile].plugins[next.alias];
            // Reinstalling the same package only moves its source; patches and the enabled state are kept.
            manifest.profiles[profile].plugins[next.alias] = current?.package === next.packageName
              ? { ...current, source: next.source }
              : { package: next.packageName, enabled: true, source: next.source };
            return next;
          });

      reportWrite(
        opts,
        overlay,
        'installed',
        { profile, alias: parsed.alias, package: parsed.packageName, source: parsed.source },
        `Installed ${parsed.packageName} (${parsed.alias}) in profile '${profile}'`
      );
    });

  program
    .command('update <alias>')
    .description('Update the declared npm version for a plugin in the manifest')
    .requiredOption('-p, --profile <name>', 'target profile', profileOption)
    .requiredOption('--to <version>', 'exact version to declare; does not float to latest')
    .option('--layer <layer>', 'layer to write when an overlay is active: base or overlay')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (!ExactVersionRegex.test(cmdOpts.to)) {
        throw new ValidationError('--to must be an exact version such as 1.2.3');
      }
      const profile: string = cmdOpts.profile;
      const version: string = cmdOpts.to;
      const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
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
      reportWrite(opts, overlay, 'updated', { profile, alias, version }, `Updated ${alias} in profile '${profile}' to ${version}`);
    });

  program
    .command('list')
    .description('List declared and unmanaged plugins')
    .option('-p, --profile <name>', 'limit to one profile', profileOption)
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

  const configCmd = program.command('config').description('Read or update declared plugin configuration');
  configCmd
    .command('get <alias>')
    .requiredOption('-p, --profile <name>', 'target profile', profileOption)
    .option('--path <dottedPath>', 'return a nested field')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
      const config = await readPluginConfig(paths, manifest, cmdOpts.profile, alias);
      const value = cmdOpts.path ? getAtPath(config.config, cmdOpts.path) : config;
      if (opts.json) {
        writeOut(JSON.stringify(value, null, 2) + '\n');
      } else {
        writeOut(`${JSON.stringify(value, null, 2)}\n`);
      }
    });
  configCmd
    .command('validate <alias>')
    .requiredOption('-p, --profile <name>', 'target profile', profileOption)
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
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
    .requiredOption('-p, --profile <name>', 'target profile', profileOption)
    .option('--layer <layer>', 'layer to write when an overlay is active: base or overlay')
    .action(async (alias: string, dottedPath: string, value: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const profile: string = cmdOpts.profile;
      const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);

      const patch = overlay
        ? await writeOverlay(paths, overlay, (doc) => {
            const plugin = effectivePlugin(paths, overlay, profile, alias);
            return setOverlayPatchValue(doc, profile, alias, plugin.patches?.[0]?.id ?? alias, dottedPath, parseConfigValue(value));
          })
        : await writeBase(paths, selection, (manifest) =>
            upsertPluginPatch(manifest, profile, alias, dottedPath, parseConfigValue(value))
          );

      reportWrite(
        opts,
        overlay,
        'set',
        { profile, alias, path: dottedPath, patch },
        `Updated ${alias} config ${dottedPath} in profile '${profile}'`,
        ' Apply to write the live patch.'
      );
    });

  for (const toggle of [
    { name: 'enable', description: 'Enable an installed plugin in a profile', enabled: true, status: 'enabled', verb: 'Enabled' },
    { name: 'disable', description: 'Disable an installed plugin in a profile', enabled: false, status: 'disabled', verb: 'Disabled' }
  ]) {
    program
      .command(`${toggle.name} <alias>`)
      .description(toggle.description)
      .requiredOption('-p, --profile <name>', 'target profile', profileOption)
      .option('--layer <layer>', 'layer to write when an overlay is active: base or overlay')
      .action(async (alias: string, cmdOpts) => {
        const opts = program.opts();
        const paths = resolveCliPaths(opts);
        const profile: string = cmdOpts.profile;
        const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);

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
    .description('Remove an installed plugin from a profile')
    .requiredOption('-p, --profile <name>', 'target profile', profileOption)
    .option('-y, --yes', 'skip confirmation')
    .option('--layer <layer>', 'layer to write when an overlay is active: base or overlay')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const profile: string = cmdOpts.profile;
      const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);

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
}
