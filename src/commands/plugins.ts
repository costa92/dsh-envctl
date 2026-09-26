import * as fs from 'node:fs';
import * as path from 'node:path';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { getAtPath, parseConfigValue, readPluginConfig, upsertPluginPatch } from '../config/config.js';
import { loadManifest, loadLock, loadState, serializeLock, serializeManifest } from '../manifest/files.js';
import { buildPlan } from '../planner/plan.js';
import { writeAtomic } from '../io/atomic-file.js';
import { readLocalSourceDigests } from '../source/local.js';
import { ValidationError } from '../errors.js';
import type { PluginSource } from '../domain.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import { resolveCliPaths, resolveCliOverlay, overlayBanner, type CommandContext } from './context.js';

export function registerPluginCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;

  function parsePluginSpec(spec: string, optsAlias?: string): { alias: string; packageName: string; source: PluginSource } {
    if (spec.startsWith('git+') || spec.startsWith('http://') || spec.startsWith('https://') || spec.startsWith('git@') || spec.endsWith('.git')) {
      const cleanUrl = spec.startsWith('git+') ? spec.slice(4) : spec;
      const urlParts = cleanUrl.split('#');
      const repoUrl = urlParts[0];
      const commitOrRef = urlParts[1];
      const baseName = path.basename(repoUrl, '.git');
      const alias = optsAlias || baseName.replace(/^(dsh-plugin-|dsh-)/, '');
      return {
        alias,
        packageName: baseName,
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
        packageName: baseName,
        source: {
          type: 'local-link',
          path: resolved
        }
      };
    }

    let packageName = spec;
    let version = '*';

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

  program
    .command('install <spec>')
    .description('Install a plugin into the manifest for a profile')
    .requiredOption('-p, --profile <name>', 'target profile')
    .option('--as <alias>', 'custom alias name for the plugin')
    .action(async (spec: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      if (!fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}. Run dshenv init first.`);
      }

      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      if (!manifest.profiles[cmdOpts.profile]) {
        manifest.profiles[cmdOpts.profile] = { plugins: {} };
      }

      const parsed = parsePluginSpec(spec, cmdOpts.as);
      manifest.profiles[cmdOpts.profile].plugins[parsed.alias] = {
        package: parsed.packageName,
        enabled: true,
        source: parsed.source
      };

      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');

      if (opts.json) {
        writeOut(JSON.stringify({ status: 'installed', profile: cmdOpts.profile, alias: parsed.alias, package: parsed.packageName, source: parsed.source }, null, 2) + '\n');
      } else {
        writeOut(`Installed ${parsed.packageName} (${parsed.alias}) in profile '${cmdOpts.profile}'.\n`);
      }
    });

  program
    .command('update <alias>')
    .description('Update the declared npm version for a plugin in the manifest')
    .requiredOption('-p, --profile <name>', 'target profile')
    .requiredOption('--to <version>', 'exact version to declare; does not float to latest')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (!fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
      }
      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      const plugin = manifest.profiles[cmdOpts.profile]?.plugins[alias];
      if (!plugin) {
        throw new ValidationError(`Plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
      }
      if (plugin.source.type !== 'npm') {
        throw new ValidationError(`update --to currently supports npm sources only (got ${plugin.source.type})`);
      }
      plugin.source = { ...plugin.source, version: cmdOpts.to };
      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');
      if (fs.existsSync(paths.lockFile)) {
        const lock = loadLock(fs.readFileSync(paths.lockFile, 'utf8'));
        const lockPlugin = lock.profiles[cmdOpts.profile]?.plugins[alias];
        if (lockPlugin?.source.type === 'npm') {
          lockPlugin.source = { ...lockPlugin.source, resolvedVersion: cmdOpts.to };
          await writeAtomic(paths.lockFile, serializeLock(lock), 'overwrite');
        }
      }
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'updated', profile: cmdOpts.profile, alias, version: cmdOpts.to }, null, 2) + '\n');
      } else {
        writeOut(`Updated ${alias} in profile '${cmdOpts.profile}' to ${cmdOpts.to}.\n`);
      }
    });

  program
    .command('list')
    .description('List declared and unmanaged plugins')
    .option('-p, --profile <name>', 'limit to one profile')
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
        writeOut(JSON.stringify({ plugins: rows }, null, 2) + '\n');
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
    .requiredOption('-p, --profile <name>', 'target profile')
    .option('--path <dottedPath>', 'return a nested field')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const config = await readPluginConfig(paths, cmdOpts.profile, alias);
      const value = cmdOpts.path ? getAtPath(config.config, cmdOpts.path) : config;
      if (opts.json) {
        writeOut(JSON.stringify(value, null, 2) + '\n');
      } else {
        writeOut(`${JSON.stringify(value, null, 2)}\n`);
      }
    });
  configCmd
    .command('validate <alias>')
    .requiredOption('-p, --profile <name>', 'target profile')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const config = await readPluginConfig(paths, cmdOpts.profile, alias);
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
    .requiredOption('-p, --profile <name>', 'target profile')
    .action(async (alias: string, dottedPath: string, value: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (!fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
      }
      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      const patch = upsertPluginPatch(manifest, cmdOpts.profile, alias, dottedPath, parseConfigValue(value));
      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'set', profile: cmdOpts.profile, alias, path: dottedPath, patch }, null, 2) + '\n');
      } else {
        writeOut(`Updated ${alias} config ${dottedPath} in profile '${cmdOpts.profile}'. Apply to write the live patch.\n`);
      }
    });

  program
    .command('enable <alias>')
    .description('Enable an installed plugin in a profile')
    .requiredOption('-p, --profile <name>', 'target profile')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      if (!fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
      }

      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      const profile = manifest.profiles[cmdOpts.profile];
      if (!profile || !profile.plugins[alias]) {
        throw new ValidationError(`Plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
      }

      profile.plugins[alias].enabled = true;
      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');

      if (opts.json) {
        writeOut(JSON.stringify({ status: 'enabled', profile: cmdOpts.profile, alias }, null, 2) + '\n');
      } else {
        writeOut(`Enabled plugin '${alias}' in profile '${cmdOpts.profile}'.\n`);
      }
    });

  program
    .command('disable <alias>')
    .description('Disable an installed plugin in a profile')
    .requiredOption('-p, --profile <name>', 'target profile')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      if (!fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
      }

      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      const profile = manifest.profiles[cmdOpts.profile];
      if (!profile || !profile.plugins[alias]) {
        throw new ValidationError(`Plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
      }

      profile.plugins[alias].enabled = false;
      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');

      if (opts.json) {
        writeOut(JSON.stringify({ status: 'disabled', profile: cmdOpts.profile, alias }, null, 2) + '\n');
      } else {
        writeOut(`Disabled plugin '${alias}' in profile '${cmdOpts.profile}'.\n`);
      }
    });

  program
    .command('remove <alias>')
    .description('Remove an installed plugin from a profile')
    .requiredOption('-p, --profile <name>', 'target profile')
    .option('-y, --yes', 'skip confirmation')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      if (!fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
      }

      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      const profile = manifest.profiles[cmdOpts.profile];
      if (!profile || !profile.plugins[alias]) {
        throw new ValidationError(`Plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
      }

      delete profile.plugins[alias];
      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');

      if (opts.json) {
        writeOut(JSON.stringify({ status: 'removed', profile: cmdOpts.profile, alias }, null, 2) + '\n');
      } else {
        writeOut(`Removed plugin '${alias}' from profile '${cmdOpts.profile}'.\n`);
      }
    });
}
