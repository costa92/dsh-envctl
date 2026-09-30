import type { CommandContext } from './context.js';

// A command that changes state previews what it would do until re-run with --yes, and like plan exits 2 while
// something is pending; --dry-run previews the same way.
export function reportPreview(ctx: CommandContext, options: { json?: boolean; dryRun?: boolean; pending: boolean; action: string }): void {
  if (!options.pending) {
    return;
  }
  ctx.setExitCode(2);
  if (!options.json) {
    ctx.writeErr(
      options.dryRun
        ? `Nothing was changed. Run it again without --dry-run and with --yes to ${options.action}.\n`
        : `Nothing was changed. Re-run with --yes to ${options.action}.\n`
    );
  }
}
