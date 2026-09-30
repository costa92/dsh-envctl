import * as fs from 'node:fs';
import * as path from 'node:path';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { captureEnvironment, initEnvironment } from '../import/capture.js';
import { adoptEnvironment } from '../import/adopt.js';
import { parseYamlStrict, serializeCaptureDocument } from '../manifest/files.js';
import { CaptureDocumentSchema } from '../manifest/schema.js';
import { writeAtomic } from '../io/atomic-file.js';
import { ValidationError } from '../errors.js';
import type { CaptureDocument } from '../domain.js';
import { assertNotRemoteOwned } from '../remote/ownership.js';
import { assertBaseMergesWithOverlay, resolveWriteLayer } from '../overlay/write.js';
import { readOverlay } from '../overlay/effective.js';
import { resolveCliPaths, resolveCliOverlay, profileOption, PROFILE_FILTER_HELP, type CommandContext } from './context.js';
import { Option } from 'commander';
import { pullProfilePatches } from '../import/pull.js';
import { renderPullResult } from './pull.js';
import { reportPreview } from './confirm.js';

export function registerSetupCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;

  program
    .command('init')
    .description('Initialize an empty dshenv environment')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      if (fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`dshenv is already initialized at ${paths.managerDir}; see dshenv status or dshenv plan`);
      }
      await initEnvironment(paths);
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'initialized', paths }, null, 2) + '\n');
      } else {
        writeOut(`Initialized dshenv environment at ${paths.managerDir}\n`);
        writeOut('Next: declare a plugin with dshenv install <package>@<version> -p <profile>, then dshenv plan and dshenv apply --yes\n');
      }
    });

  program
    .command('capture')
    .description('Capture existing DSH environment into reviewable candidate manifest')
    .option('-o, --output <file>', 'output candidate manifest file')
    .option('-p, --profile <name>', PROFILE_FILTER_HELP, profileOption)
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const inventory = await readEnvironmentInventory(paths);
      const captureDoc = captureEnvironment(inventory, {
        profile: cmdOpts.profile
      });

      if (cmdOpts.output) {
        const targetOutput = path.isAbsolute(cmdOpts.output)
          ? cmdOpts.output
          : path.resolve(process.cwd(), cmdOpts.output);
        const yamlOutput = serializeCaptureDocument(captureDoc);
        await writeAtomic(targetOutput, yamlOutput, 'create');
        if (opts.json) {
          writeOut(JSON.stringify({ status: 'captured', file: targetOutput, warnings: captureDoc.warnings }, null, 2) + '\n');
        } else {
          writeOut(`Environment captured successfully to ${targetOutput}\n`);
        }
      } else {
        if (opts.json) {
          writeOut(JSON.stringify(captureDoc, null, 2) + '\n');
        } else {
          writeOut(serializeCaptureDocument(captureDoc));
        }
      }
    });

  program
    .command('adopt')
    .description('Adopt a candidate capture manifest into active environment management')
    .requiredOption('-f, --from <file>', '(required) path to candidate capture manifest')
    .option('-y, --yes', 'adopt; without it adopt only previews what it would take over')
    // Only base is valid, so the option is accepted for scripts that pass it but not shown.
    .addOption(new Option('--layer <layer>').hideHelp())
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      const selection = resolveCliOverlay(opts, paths);
      if (resolveWriteLayer(selection, cmdOpts.layer) === 'overlay') {
        throw new ValidationError('adopt only writes the base manifest; use --layer base');
      }
      // Adopt rewrites the base and the whole lock; a subscription always owns the base, so team lock entries stay intact too.
      assertNotRemoteOwned(paths, paths.manifestFile);

      const candidatePath = path.isAbsolute(cmdOpts.from)
        ? cmdOpts.from
        : path.resolve(process.cwd(), cmdOpts.from);

      if (!fs.existsSync(candidatePath)) {
        throw new ValidationError(`Candidate file not found: ${candidatePath}`);
      }

      const content = fs.readFileSync(candidatePath, 'utf8');
      const raw = parseYamlStrict(content);
      const parsed = CaptureDocumentSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
        throw new ValidationError(`Invalid candidate schema: ${issues}`);
      }

      const summary = await adoptEnvironment(paths, parsed.data as CaptureDocument, {
        validateManifest: (manifest) => assertBaseMergesWithOverlay(paths, selection, manifest),
        dryRun: !cmdOpts.yes,
        overlay: selection ? readOverlay(paths, selection.name) : undefined
      });
      if (!cmdOpts.yes) {
        const pending = summary.details.filter((d) => !d.alreadyAdopted);
        if (opts.json) {
          writeOut(JSON.stringify({ ...summary, dryRun: true }, null, 2) + '\n');
        } else if (summary.details.length === 0) {
          writeOut('Nothing to adopt: the candidate declares no plugins.\n');
        } else if (pending.length === 0) {
          writeOut('Nothing to adopt: every plugin in the candidate is already adopted.\n');
        } else {
          const profiles = [...new Set(pending.map((d) => d.profile))];
          writeOut(`Would adopt ${pending.length} plugin(s) across profile(s): ${profiles.join(', ')}\n`);
          for (const d of pending) {
            writeOut(`  + [${d.profile}] ${d.package} (${d.alias}) [${d.sourceType}]\n`);
          }
        }
        reportPreview(ctx, { json: opts.json, pending: pending.length > 0, action: 'adopt' });
        return;
      }
      // Taking over a profile includes the settings DSH wrote into its patch file.
      let patches: Awaited<ReturnType<typeof pullProfilePatches>> | null = null;
      try {
        patches = summary.profiles.length > 0
          ? await pullProfilePatches(paths, { profiles: summary.profiles, selection, allowOverlayCreation: opts.overlay !== false, plugins: false })
          : null;
      } catch (err) {
        // The adoption is already written; only the pull remains, so say so rather than suggest adopt failed.
        if (err instanceof Error) {
          err.message =
            `Adopted ${summary.adoptedCount} plugin(s) across profile(s): ${summary.profiles.join(', ')}, ` +
            `but taking over their patch entries failed: ${err.message}; fix that and run dshenv pull`;
        }
        throw err;
      }

      if (opts.json) {
        writeOut(JSON.stringify(patches ? { ...summary, patches } : summary, null, 2) + '\n');
      } else {
        writeOut(
          summary.adoptedCount === 0
            ? 'Nothing to adopt: the candidate declares no plugins.\n'
            : `Adopted ${summary.adoptedCount} plugin(s) across profile(s): ${summary.profiles.join(', ')}\n`
        );
        for (const d of summary.details) {
          writeOut(`  + [${d.profile}] ${d.package} (${d.alias}) [${d.sourceType}]\n`);
        }
        if (patches && patches.changes.length > 0) {
          writeOut(renderPullResult(patches));
        }
        writeOut('Next: dshenv plan\n');
      }
    });
}
