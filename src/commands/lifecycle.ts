import * as fs from 'node:fs';
import { applyEnvironment } from '../apply/apply.js';
import { rollbackEnvironment } from '../rollback/rollback.js';
import { gcEnvironment } from '../gc/gc.js';
import { purgePlugin } from '../purge/purge.js';
import { markRestarted } from '../restart/restart.js';
import { renderPlan } from '../output/render.js';
import { ValidationError } from '../errors.js';
import { loadEffectiveManifest, overlaySwitchWarning } from '../overlay/effective.js';
import { loadState } from '../manifest/files.js';
import { resolveCliPaths, resolveCliOverlay, overlayBanner, type CommandContext } from './context.js';

export function registerLifecycleCommands(ctx: CommandContext): void {
  const { program, writeOut, writeErr } = ctx;

  program
    .command('apply')
    .description('Apply declared environment manifest to DSH profile installations')
    .option('--dry-run', 'simulate apply without modifying state or acquiring exclusive locks')
    .option('-y, --yes', 'skip confirmation')
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const allowUntested = Boolean(opts.allowUntestedDsh);

      if (!cmdOpts.dryRun && !cmdOpts.yes) {
        throw new ValidationError('Refusing to apply without --yes. Preview with --dry-run, then re-run with --yes.');
      }

      const selection = resolveCliOverlay(opts, paths);
      const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
      const warning = overlaySwitchWarning(state, selection);
      if (warning) {
        writeErr(`${warning}\n`);
      }

      const res = await applyEnvironment(paths, {
        dryRun: Boolean(cmdOpts.dryRun),
        allowUntested,
        harnessSource: opts.harnessSource,
        overlay: selection
      });

      if (opts.json) {
        writeOut(JSON.stringify(selection ? { ...res, overlay: selection } : res, null, 2) + '\n');
      } else {
        if (selection) {
          writeOut(overlayBanner(selection));
        }
        if (res.dryRun) {
          writeOut(`[DRY-RUN] Planned operations:\n` + renderPlan(res.plan));
        } else if (res.applied) {
          writeOut(`Successfully applied changes (Operation ID: ${res.operationId})\n`);
          writeOut(renderPlan(res.plan));
        } else {
          writeOut(`${res.message ?? 'No changes applied.'}\n`);
        }
      }
    });

  program
    .command('rollback [operationId]')
    .description('Restore envctl management files from an apply snapshot')
    .option('--dry-run', 'show which snapshot would be restored')
    .option('-y, --yes', 'confirm restoring management files')
    .action(async (operationId: string | undefined, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (!cmdOpts.dryRun && !cmdOpts.yes) {
        throw new ValidationError('Refusing to rollback without --yes. Preview with --dry-run, then re-run with --yes.');
      }
      const result = await rollbackEnvironment(paths, {
        operationId,
        dryRun: Boolean(cmdOpts.dryRun)
      });
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
      } else {
        writeOut(`${result.message}\n`);
      }
    });

  program
    .command('purge <plugin>')
    .description('Move owned managed patch (and envctl/sources clone) into trash')
    .requiredOption('-p, --profile <name>', 'target profile')
    .option('--dry-run', 'list resources that would be moved')
    .option('-y, --yes', 'confirm moving owned resources into trash')
    .action(async (plugin: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (!cmdOpts.dryRun && !cmdOpts.yes) {
        throw new ValidationError('Refusing to purge without --yes. Preview with --dry-run, then re-run with --yes.');
      }
      const result = await purgePlugin(paths, cmdOpts.profile, plugin, {
        dryRun: Boolean(cmdOpts.dryRun),
        manifest: fs.existsSync(paths.manifestFile)
          ? loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest
          : null
      });
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
      } else {
        writeOut(`${result.message}\n`);
        for (const item of result.moved) {
          writeOut(`  -> ${item}\n`);
        }
      }
    });

  program
    .command('gc')
    .description('Delete expired entries under envctl/trash')
    .option('--older-than <days>', 'delete trash older than this many days', '7')
    .option('--dry-run', 'list trash that would be deleted')
    .option('-y, --yes', 'confirm deleting expired trash')
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (!cmdOpts.dryRun && !cmdOpts.yes) {
        throw new ValidationError('Refusing to gc without --yes. Preview with --dry-run, then re-run with --yes.');
      }
      const olderThanDays = Number(cmdOpts.olderThan);
      if (!Number.isFinite(olderThanDays)) {
        throw new ValidationError(`Invalid --older-than value: ${cmdOpts.olderThan}`);
      }
      const result = await gcEnvironment(paths, {
        olderThanDays,
        dryRun: Boolean(cmdOpts.dryRun)
      });
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
      } else {
        writeOut(`${result.message}\n`);
        for (const item of result.deleted) {
          writeOut(`  - ${item}\n`);
        }
      }
    });

  program
    .command('restarted')
    .description('Record that DSH was restarted, clearing restart-required')
    .option('-p, --profile <name>', 'only clear this profile')
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const result = await markRestarted(resolveCliPaths(opts), cmdOpts.profile);
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'restarted', cleared: result.cleared }, null, 2) + '\n');
      } else {
        writeOut(`Cleared restart-required for ${result.cleared.length} plugin(s).\n`);
      }
    });
}
