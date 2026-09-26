import * as fs from 'node:fs';
import { ValidationError } from '../errors.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import { isValidOverlayName, validateOverlayName, writeSelectionFile } from '../overlay/selection.js';
import { overlayBanner, resolveCliOverlay, resolveCliPaths, type CommandContext } from './context.js';

export function registerOverlayCommands(ctx: CommandContext): void {
  const { program, writeOut, writeErr } = ctx;
  const overlayCmd = program.command('overlay').description('Select and inspect per-machine manifest overlays');

  overlayCmd
    .command('use [name]')
    .description('Persist the overlay that later commands on this machine use')
    .option('--none', 'clear the persisted overlay')
    .action(async (name: string | undefined, cmdOpts: { none?: boolean }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (Boolean(name) === Boolean(cmdOpts.none)) {
        throw new ValidationError('overlay use requires exactly one of <name> or --none');
      }
      if (name) {
        loadEffectiveManifest(paths, { name: validateOverlayName(name), via: 'file' });
      }
      await writeSelectionFile(paths, name ?? null);
      if (process.env.DSHENV_OVERLAY && process.env.DSHENV_OVERLAY !== name) {
        writeErr(`DSHENV_OVERLAY=${process.env.DSHENV_OVERLAY} takes precedence over the saved overlay in this shell\n`);
      }
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'selected', overlay: name ? { name, via: 'file' } : null }, null, 2) + '\n');
      } else {
        writeOut(name ? `Using overlay '${name}'. Run dshenv plan to review its effect.\n` : 'Cleared the persisted overlay.\n');
      }
    });

  overlayCmd
    .command('list')
    .description('List overlays under envctl/overlays and mark the active one')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const names = fs.existsSync(paths.overlaysDir)
        ? fs.readdirSync(paths.overlaysDir).filter((file) => file.endsWith('.yaml')).map((file) => file.slice(0, -'.yaml'.length)).sort()
        : [];
      const active = resolveCliOverlay(opts, paths);
      const overlays: Array<{ name: string; active: boolean; missing?: boolean; invalid?: boolean }> = names.map((name) => ({
        name,
        active: name === active?.name,
        ...(isValidOverlayName(name) ? {} : { invalid: true })
      }));
      if (active && !names.includes(active.name)) {
        overlays.push({ name: active.name, active: true, missing: true });
      }
      if (opts.json) {
        writeOut(JSON.stringify({ active, overlays }, null, 2) + '\n');
        return;
      }
      for (const entry of overlays) {
        const missing = entry.missing ? ' missing' : '';
        const invalid = entry.invalid ? ' (invalid name)' : '';
        writeOut(entry.active && active ? `* ${entry.name} (${active.via})${missing}\n` : `  ${entry.name}${invalid}\n`);
      }
    });

  overlayCmd
    .command('show')
    .description('Show the merged manifest and where each plugin comes from')
    .option('-p, --profile <name>', 'limit to one profile')
    .action(async (cmdOpts: { profile?: string }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const effective = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths));
      const profileNames = cmdOpts.profile ? [cmdOpts.profile] : Object.keys(effective.manifest.profiles).sort();
      if (cmdOpts.profile && !effective.manifest.profiles[cmdOpts.profile]) {
        throw new ValidationError(`Profile '${cmdOpts.profile}' not found in the effective manifest`);
      }
      if (opts.json) {
        const pick = <T>(record: Record<string, T>) => Object.fromEntries(profileNames.map((name) => [name, record[name]]));
        writeOut(JSON.stringify({
          overlay: effective.overlay,
          manifest: { ...effective.manifest, profiles: pick(effective.manifest.profiles) },
          provenance: pick(effective.provenance)
        }, null, 2) + '\n');
        return;
      }
      if (effective.overlay) {
        writeOut(overlayBanner(effective.overlay));
      }
      for (const profileName of profileNames) {
        const plugins = effective.manifest.profiles[profileName].plugins;
        for (const alias of Object.keys(plugins).sort()) {
          const provenance = effective.provenance[profileName]?.[alias];
          const overrides = provenance?.overridden.length ? ` overrides=${provenance.overridden.join(',')}` : '';
          writeOut(`${profileName} ${alias} ${plugins[alias].package} origin=${provenance?.origin ?? 'base'}${overrides}\n`);
        }
      }
    });
}
