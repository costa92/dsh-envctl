import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveEnvironmentPaths } from './environment/paths.js';
import { readEnvironmentInventory } from './inventory/profile-reader.js';
import { captureEnvironment, initEnvironment } from './capture/capture.js';
import {
  loadManifest,
  loadLock,
  loadState,
  serializeCaptureDocument
} from './manifest/files.js';
import { buildPlan, buildStatus } from './planner/plan.js';
import { renderPlan, renderStatus } from './output/render.js';
import { writeAtomic } from './io/atomic-file.js';
import { DshError, ValidationError } from './errors.js';
import type { EnvironmentManifest, EnvironmentLock, EnvironmentState } from './domain.js';

export interface CliIO {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

export async function runCli(argv: string[], io?: CliIO): Promise<number> {
  const writeOut = io?.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = io?.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  let exitCodeToReturn = 0;

  const program = new Command();
  program
    .name('dshenv')
    .description('Environment-as-Code manager for DeepSeek Harness')
    .version('0.1.0', '-v, --version', 'output the current version')
    .option('--dsh-home <path>', 'custom DSH home directory')
    .option('--harness-source <path>', 'custom DSH source directory')
    .option('--json', 'output in structured JSON format')
    .configureOutput({
      writeOut: (str) => writeOut(str),
      writeErr: (str) => writeErr(str)
    })
    .exitOverride();

  program
    .command('init')
    .description('Initialize an empty dshenv environment')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveEnvironmentPaths({
        cliDshHome: opts.dshHome
      });
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
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveEnvironmentPaths({
        cliDshHome: opts.dshHome
      });
      const inventory = await readEnvironmentInventory(paths);
      const captureDoc = captureEnvironment(paths, inventory);

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
    .command('plan')
    .description('Plan drift between target manifest and actual DSH environment')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveEnvironmentPaths({
        cliDshHome: opts.dshHome
      });

      let manifest: EnvironmentManifest | null = null;
      let lock: EnvironmentLock | null = null;

      if (fs.existsSync(paths.manifestFile)) {
        const content = fs.readFileSync(paths.manifestFile, 'utf8');
        manifest = loadManifest(content);
      } else {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
      }

      if (fs.existsSync(paths.lockFile)) {
        const content = fs.readFileSync(paths.lockFile, 'utf8');
        lock = loadLock(content);
      }

      const inventory = await readEnvironmentInventory(paths);
      const plan = buildPlan(manifest, lock, inventory);

      if (opts.json) {
        writeOut(JSON.stringify(plan, null, 2) + '\n');
      } else {
        writeOut(renderPlan(plan));
      }

      if (plan.hasChanges) {
        exitCodeToReturn = 2;
      }
    });

  program
    .command('status')
    .description('Display status summary of DSH environment and manifests')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveEnvironmentPaths({
        cliDshHome: opts.dshHome
      });

      let manifest: EnvironmentManifest | null = null;
      let lock: EnvironmentLock | null = null;
      let state: EnvironmentState | null = null;

      if (fs.existsSync(paths.manifestFile)) {
        const content = fs.readFileSync(paths.manifestFile, 'utf8');
        manifest = loadManifest(content);
      }
      if (fs.existsSync(paths.lockFile)) {
        const content = fs.readFileSync(paths.lockFile, 'utf8');
        lock = loadLock(content);
      }
      if (fs.existsSync(paths.stateFile)) {
        const content = fs.readFileSync(paths.stateFile, 'utf8');
        state = loadState(content);
      }

      const inventory = await readEnvironmentInventory(paths);
      const plan = buildPlan(manifest, lock, inventory);
      const summary = buildStatus(manifest, lock, state, inventory, plan);

      if (opts.json) {
        writeOut(JSON.stringify(summary, null, 2) + '\n');
      } else {
        writeOut(renderStatus(summary));
      }

      if (plan.hasChanges) {
        exitCodeToReturn = 2;
      }
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCodeToReturn;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'exitCode' in err) {
      const exitCode = (err as { exitCode: number }).exitCode;
      return typeof exitCode === 'number' ? exitCode : 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`${message}\n`);
    if (err instanceof DshError) {
      return err.exitCode;
    }
    return 1;
  }
}
