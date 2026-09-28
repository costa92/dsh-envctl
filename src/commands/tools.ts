import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProfilePatch } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { getAtPath, parseConfigValue } from '../config/config.js';
import { resolveDshCommand } from '../dsh/command.js';
import { dumpProfileConfig } from '../dsh/hmr.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import type { OverlaySelection } from '../overlay/selection.js';
import { mergeProfilePatches, overrideKey } from '../profile-patches/entries.js';
import {
  TOOL_CATEGORIES,
  declaredToolRow,
  listTools,
  locateTool,
  parseComposedProfile,
  toolPatch,
  type ToolCategory,
  type ToolChange,
  type ToolRow,
  type ToolTarget
} from '../tools/catalog.js';
import { resolveWrite, writeBase, writeOverlay } from './manifest-write.js';
import { profileOption, resolveCliOverlay, resolveCliPaths, type CommandContext } from './context.js';

const CATEGORY_TITLES: Record<ToolCategory, string> = {
  terminal: 'Terminal',
  filesystem: 'Filesystem',
  network: 'Network',
  code: 'Code / LSP',
  orchestration: 'Orchestration',
  interaction: 'Interaction',
  extend: 'Sessions, skills and introspection',
  other: 'Other'
};

interface CliOpts {
  dshHome?: string;
  harnessSource?: string;
  overlay?: string | false;
  json?: boolean;
}

function declaredPatches(paths: EnvironmentPaths, selection: OverlaySelection | null, profile: string): ProfilePatch[] {
  if (!fs.existsSync(paths.manifestFile)) {
    return [];
  }
  return loadEffectiveManifest(paths, selection).manifest.profiles[profile]?.patches ?? [];
}

async function composedProfile(paths: EnvironmentPaths, opts: CliOpts, profile: string): Promise<ProfilePatch[]> {
  // dsh --dump-config creates a missing profile, which only reading tools must not do.
  if (!fs.existsSync(path.join(paths.profilesDir, profile, 'package.json'))) {
    throw new ValidationError(`Profile '${profile}' does not exist; start DSH with --profile ${profile} once`);
  }
  const manifestSource = fs.existsSync(paths.manifestFile)
    ? loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest.environment?.harness?.sourceDir
    : undefined;
  const command = resolveDshCommand({ cliHarnessSource: opts.harnessSource, manifestHarnessSource: manifestSource });
  const dump = await dumpProfileConfig(profile, { command, dshHome: paths.home });
  if (!dump.ok) {
    throw new ValidationError(`Could not read profile '${profile}' from dsh --dump-config: ${dump.reason}`);
  }
  return parseComposedProfile(dump.yaml);
}

function stateText(tool: ToolRow): { symbol: string; note: string } {
  if (tool.state === 'on') return { symbol: '+', note: '' };
  if (tool.state === 'off') return { symbol: '-', note: 'off' };
  return { symbol: '~', note: `off when ${tool.state.offWhen}` };
}

// `onePreset`: the view of a single preset, where rows outside it are profile-wide.
function renderTools(header: string, tools: ToolRow[], onePreset: boolean): string {
  const lines = [header];
  const idWidth = Math.max(...tools.map((tool) => tool.id.length), 0);
  const nameWidth = Math.max(...tools.map((tool) => tool.name.length), 0);
  for (const category of TOOL_CATEGORIES) {
    const inCategory = tools.filter((tool) => tool.category === category);
    if (inCategory.length === 0) continue;
    lines.push(CATEGORY_TITLES[category]);
    for (const tool of inCategory) {
      const { symbol, note } = stateText(tool);
      const where = tool.location.kind === 'top'
        ? onePreset ? 'profile-wide' : ''
        : [onePreset ? '' : `preset ${tool.location.preset}`, tool.location.group ? `group ${tool.location.group}` : ''].filter(Boolean).join(', ');
      const notes = [note, where].filter(Boolean).join('; ');
      lines.push(`  ${symbol} ${tool.id.padEnd(idWidth)}  ${tool.name.padEnd(nameWidth)}${notes ? `  ${notes}` : ''}`.trimEnd());
    }
  }
  if (tools.length === 0) lines.push('  (no tools)');
  return `${lines.join('\n')}\n`;
}

function describeTarget(profile: string, target: ToolTarget): string {
  return target.location.kind === 'preset'
    ? `in preset '${target.location.preset}' of profile '${profile}'`
    : `in profile '${profile}'`;
}

function upsertPatch(list: ProfilePatch[] | undefined, patch: ProfilePatch): ProfilePatch[] {
  const next = [...(list ?? [])];
  const index = next.findIndex((entry) => overrideKey(entry) === patch.id);
  if (index === -1) next.push(patch);
  else next[index] = patch;
  return next;
}

export function registerToolsCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;
  const tools = program.command('tools').description("List, switch and configure DSH's built-in tools in a profile");

  tools
    .command('list')
    .description("List a profile's tools by category, as an agent of the chosen preset gets them")
    .requiredOption('-p, --profile <name>', 'target profile', profileOption)
    .option('--preset <name>', 'agent preset to show (default: the profile default)')
    .option('--all', 'every tool row: profile-wide and in each preset')
    .action(async (cmdOpts) => {
      const opts: CliOpts = program.opts();
      const paths = resolveCliPaths(opts);
      const tree = await composedProfile(paths, opts, cmdOpts.profile);
      const rows = listTools(tree, { preset: cmdOpts.preset, all: Boolean(cmdOpts.all) });
      const shown = cmdOpts.all ? undefined : rows.find((row) => row.location.kind === 'preset')?.location;
      const presetName = shown?.kind === 'preset' ? shown.preset : undefined;
      if (opts.json) {
        const json = rows.map((row) => ({
          id: row.id,
          name: row.name,
          category: row.category,
          state: typeof row.state === 'string' ? row.state : 'conditional',
          ...(typeof row.state === 'string' ? {} : { offWhen: row.state.offWhen }),
          location: row.location
        }));
        writeOut(`${JSON.stringify({ profile: cmdOpts.profile, ...(presetName ? { preset: presetName } : {}), tools: json }, null, 2)}\n`);
        return;
      }
      const header = cmdOpts.all
        ? `Tools in profile '${cmdOpts.profile}', every location:`
        : presetName
          ? `Tools in profile '${cmdOpts.profile}', preset '${presetName}'${cmdOpts.preset ? '' : ' (default)'}:`
          : `Tools in profile '${cmdOpts.profile}':`;
      writeOut(renderTools(header, rows, presetName !== undefined));
    });

  async function change(toolId: string, cmdOpts: { profile: string; preset?: string; layer?: string }, toolChange: ToolChange, verb: string): Promise<void> {
    const opts: CliOpts = program.opts();
    const paths = resolveCliPaths(opts);
    const { selection, overlay } = resolveWrite(opts, paths, cmdOpts.layer);
    const tree = await composedProfile(paths, opts, cmdOpts.profile);
    const target = locateTool(tree, toolId, cmdOpts.preset);
    // Built under the write lock from the layer written, so a concurrent edit of the same preset is kept and
    // a base write never takes in what the overlay declares. An overlay entry replaces the base one, so it starts from both.
    const patch = overlay
      ? await writeOverlay(paths, overlay, (doc, base) => {
          const profile = ((doc.profiles ??= {})[cmdOpts.profile] ??= {});
          const next = toolPatch(tree, mergeProfilePatches(base.profiles[cmdOpts.profile]?.patches ?? [], profile.patches ?? []), target, toolChange);
          profile.patches = upsertPatch(profile.patches, next);
          return next;
        })
      : await writeBase(paths, selection, (manifest) => {
          const profile = (manifest.profiles[cmdOpts.profile] ??= { plugins: {} });
          const next = toolPatch(tree, profile.patches ?? [], target, toolChange);
          profile.patches = upsertPatch(profile.patches, next);
          return next;
        });
    const location = target.location;
    const pinned = location.kind === 'preset'
      ? `\nPreset '${location.preset}' is now pinned in the manifest as patch '${location.entry}': DSH upgrades to this preset no longer apply until that patch is removed.`
      : '';
    if (opts.json) {
      writeOut(`${JSON.stringify({ status: verb.toLowerCase(), profile: cmdOpts.profile, tool: toolId, location, patch, ...(overlay ? { layer: 'overlay', overlay: overlay.name } : {}) }, null, 2)}\n`);
    } else {
      writeOut(`${verb} tool '${toolId}' ${describeTarget(cmdOpts.profile, target)}${overlay ? ` (overlay '${overlay.name}')` : ''}. Apply to write the live patch.${pinned}\n`);
    }
  }

  for (const toggle of [
    { name: 'enable', verb: 'Enabled', kind: 'enable' as const },
    { name: 'disable', verb: 'Disabled', kind: 'disable' as const }
  ]) {
    tools
      .command(`${toggle.name} <tool>`)
      .description(`${toggle.verb.replace(/d$/, '')} a tool row by its id (see tools list)`)
      .requiredOption('-p, --profile <name>', 'target profile', profileOption)
      .option('--preset <name>', 'agent preset holding the tool (default: the profile default)')
      .option('--layer <layer>', 'layer to write when an overlay is active: base or overlay')
      .action((tool: string, cmdOpts) => change(tool, cmdOpts, { kind: toggle.kind }, toggle.verb));
  }

  tools
    .command('config <tool> [dottedPath] [value]')
    .description("Show a tool's config, one key of it, or set that key (the patch restates the whole config)")
    .requiredOption('-p, --profile <name>', 'target profile', profileOption)
    .option('--preset <name>', 'agent preset holding the tool (default: the profile default)')
    .option('--layer <layer>', 'layer to write when an overlay is active: base or overlay')
    .action(async (tool: string, dottedPath: string | undefined, value: string | undefined, cmdOpts) => {
      if (dottedPath !== undefined && value !== undefined) {
        await change(tool, cmdOpts, { kind: 'set', path: dottedPath, value: parseConfigValue(value) }, `Set ${dottedPath} of`);
        return;
      }
      const opts: CliOpts = program.opts();
      const paths = resolveCliPaths(opts);
      const tree = await composedProfile(paths, opts, cmdOpts.profile);
      const target = locateTool(tree, tool, cmdOpts.preset);
      const config = declaredToolRow(tree, declaredPatches(paths, resolveCliOverlay(opts, paths), cmdOpts.profile), target).config ?? {};
      const shown = dottedPath === undefined ? config : getAtPath(config as Record<string, unknown>, dottedPath);
      writeOut(`${JSON.stringify(shown ?? null, null, 2)}\n`);
    });
}
