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
import { buildPlan, buildStatus, planExitCode } from './planner/plan.js';
import { renderPlan, renderStatus, renderDoctor, type DoctorReport } from './output/render.js';
import { writeAtomic } from './io/atomic-file.js';
import { resolveDshCommand, probeDsh, capabilitiesFor, evaluateCapabilities, probeOfficialSurfaces, type RuntimeCapabilityEvidence } from './dsh/index.js';
import { DshError, ValidationError, CapabilityError } from './errors.js';
import type { EnvironmentManifest, EnvironmentLock, EnvironmentState } from './domain.js';
import type { EnvironmentPaths } from './environment/paths.js';

function resolveCliPaths(opts: { dshHome?: string }): EnvironmentPaths {
  return resolveEnvironmentPaths({
    cliDshHome: opts.dshHome,
    envDshHome: process.env.DSH_HOME,
    cwd: process.cwd()
  });
}

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
    .command('plan')
    .description('Plan drift between target manifest and actual DSH environment')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

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

      exitCodeToReturn = planExitCode(plan);
    });

  program
    .command('status')
    .description('Display status summary of DSH environment and manifests')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

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

      if (summary.status === 'degraded' || summary.status === 'incompatible') {
        exitCodeToReturn = 5;
      } else {
        exitCodeToReturn = planExitCode(plan);
      }
    });

  program
    .command('doctor')
    .description('Probe DSH runtime and inspect environment readiness')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      let manifestHarnessSource: string | undefined;
      if (fs.existsSync(paths.manifestFile)) {
        try {
          const m = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
          manifestHarnessSource = m.environment?.harness?.sourceDir;
        } catch {
          // ignore manifest error during doctor probing
        }
      }

      const dshCmd = resolveDshCommand({
        cliHarnessSource: opts.harnessSource,
        manifestHarnessSource
      });

      if (!dshCmd) {
        throw new CapabilityError('DSH command could not be resolved from DSH_CLI, harness-source, or PATH');
      }

      const probeResult = await probeDsh(dshCmd);
      const caps = capabilitiesFor(probeResult.version);

      if (caps.discovery.status !== 'available') {
        throw new CapabilityError('Unsupported DSH version');
      }

      const evidence: RuntimeCapabilityEvidence = dshCmd.cwd
        ? await probeOfficialSurfaces({ harnessSourceDir: dshCmd.cwd })
        : {
          operationsExport: {
            declared: false,
            targetExists: false,
            exportName: caps.operationsExport ?? ''
          },
          liveService: { configured: false, reachable: false },
          diagnostics: ['HARNESS_SOURCE_UNAVAILABLE']
        };
      const evaluatedCaps = evaluateCapabilities(probeResult.version, evidence);

      const report: DoctorReport = {
        runtime: {
          command: dshCmd.file,
          version: probeResult.version,
          discoverySupported: evaluatedCaps.discovery.status === 'available',
          mutationsSupported: evaluatedCaps.mutations,
          capabilities: evaluatedCaps
        },
        paths: {
          home: paths.home,
          managerDir: paths.managerDir,
          manifestExists: fs.existsSync(paths.manifestFile),
          lockExists: fs.existsSync(paths.lockFile),
          stateExists: fs.existsSync(paths.stateFile)
        }
      };

      if (opts.json) {
        writeOut(JSON.stringify(report, null, 2) + '\n');
      } else {
        writeOut(renderDoctor(report));
      }
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCodeToReturn;
  } catch (err: unknown) {
    const isCommanderError = err && typeof err === 'object' && (err as { code?: string }).code?.startsWith('commander.');
    if (isCommanderError) {
      const exitCode = (err as { exitCode?: number }).exitCode;
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
