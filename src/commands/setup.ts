import * as fs from 'node:fs';
import * as path from 'node:path';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { captureEnvironment, initEnvironment } from '../capture/capture.js';
import { adoptEnvironment } from '../adopt/adopt.js';
import { parseYamlStrict, serializeCaptureDocument } from '../manifest/files.js';
import { CaptureDocumentSchema } from '../manifest/schema.js';
import { writeAtomic } from '../io/atomic-file.js';
import { ValidationError } from '../errors.js';
import type { CaptureDocument } from '../domain.js';
import { resolveWriteLayer } from '../overlay/write.js';
import { resolveCliPaths, resolveCliOverlay, type CommandContext } from './context.js';

export function registerSetupCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;

  program
    .command('init')
    .description('Initialize an empty dshenv environment')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      await initEnvironment(paths);
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'initialized', paths }, null, 2) + '\n');
      } else {
        writeOut(`Initialized dshenv environment at ${paths.managerDir}\n`);
      }
    });

  program
    .command('capture')
    .description('Capture existing DSH environment into reviewable candidate manifest')
    .option('-o, --output <file>', 'output candidate manifest file')
    .option('--profile <name>', 'capture a single profile')
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const inventory = await readEnvironmentInventory(paths);
      const captureDoc = captureEnvironment(paths, inventory, {
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
    .requiredOption('-f, --from <file>', 'path to candidate capture manifest')
    .option('-y, --yes', 'skip confirmation')
    .option('--layer <layer>', 'layer to write when an overlay is active; adopt only supports base')
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      if (resolveWriteLayer(resolveCliOverlay(opts, paths), cmdOpts.layer) === 'overlay') {
        throw new ValidationError('adopt only writes the base manifest; use --layer base');
      }

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

      const summary = await adoptEnvironment(paths, parsed.data as CaptureDocument);

      if (opts.json) {
        writeOut(JSON.stringify(summary, null, 2) + '\n');
      } else {
        writeOut(`Adopted ${summary.adoptedCount} plugin(s) across profile(s): ${summary.profiles.join(', ')}\n`);
        for (const d of summary.details) {
          writeOut(`  + [${d.profile}] ${d.package} (${d.alias}) [${d.sourceType}]\n`);
        }
      }
    });
}
