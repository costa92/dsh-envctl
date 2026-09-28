import { ValidationError } from '../errors.js';
import { pullProfilePatches, type PullResult } from '../profile-patches/pull.js';
import { resolveCliPaths, resolveCliOverlay, profileOption, type CommandContext } from './context.js';

export function renderPullResult(result: PullResult): string {
  if (result.changes.length === 0) {
    return 'Nothing to pull: every patch entry in DSH matches the manifest.\n';
  }
  const lines = result.changes.map((change) => {
    const entries = [
      ...change.added.map((id) => `+ ${id}`),
      ...change.changed.map((id) => `~ ${id}`),
      ...change.removed.map((id) => `- ${id}`)
    ];
    const layers = `base ${change.base}${change.overlayName ? `, overlay '${change.overlayName}' ${change.overlay}` : ''}`;
    const summary = entries.length > 0 ? entries.join(', ') : 'rewrites the block';
    return change.from === 'manifest'
      ? `[${change.profile}] keeps the manifest, dropping DSH's edits (${layers})`
      : `[${change.profile}] from DSH: ${summary} (${layers})`;
  });
  if (result.overlayCreated) {
    lines.push(`Machine-local entries went into overlay '${result.overlayCreated}', now selected.`);
  }
  lines.push(result.dryRun ? 'Dry run: nothing was written.' : 'Next: dshenv plan');
  return `${lines.join('\n')}\n`;
}

export function registerPullCommand(ctx: CommandContext): void {
  const { program, writeOut, setExitCode } = ctx;

  program
    .command('pull')
    .description('Take patch entries changed or added in DSH into the manifest')
    .option('-p, --profile <name>', 'only this profile', profileOption)
    .option('--prefer <side>', 'when both DSH and the manifest changed since the last apply: dsh or manifest')
    .option('--dry-run', 'show what would be taken over without writing')
    .action(async (cmdOpts) => {
      if (cmdOpts.prefer !== undefined && cmdOpts.prefer !== 'dsh' && cmdOpts.prefer !== 'manifest') {
        throw new ValidationError(`Invalid --prefer '${cmdOpts.prefer}'; expected dsh or manifest`);
      }
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const result = await pullProfilePatches(paths, {
        profiles: cmdOpts.profile ? [cmdOpts.profile] : undefined,
        prefer: cmdOpts.prefer,
        dryRun: Boolean(cmdOpts.dryRun),
        selection: resolveCliOverlay(opts, paths),
        allowOverlayCreation: opts.overlay !== false
      });
      writeOut(opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderPullResult(result));
      if (result.dryRun && result.changes.length > 0) {
        setExitCode(2);
      }
    });
}
