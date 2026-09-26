import * as fs from 'node:fs';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import { loadManifest, loadLock, loadState } from '../manifest/files.js';
import { buildPlan, buildStatus, planExitCode } from '../planner/plan.js';
import { renderPlan, renderStatus, renderDoctor, type DoctorReport } from '../output/render.js';
import { resolveDshCommand, probeDsh, capabilitiesFor, evaluateCapabilities, probeOfficialSurfaces, type RuntimeCapabilityEvidence } from '../dsh/index.js';
import { readLocalSourceDigests } from '../source/local.js';
import { ValidationError, CapabilityError } from '../errors.js';
import type { EnvironmentManifest, EnvironmentLock, EnvironmentState } from '../domain.js';
import { resolveCliPaths, type CommandContext } from './context.js';

export function registerInspectCommands(ctx: CommandContext): void {
  const { program, writeOut, setExitCode } = ctx;

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

      let planState: EnvironmentState | null = null;
      if (fs.existsSync(paths.stateFile)) {
        planState = loadState(fs.readFileSync(paths.stateFile, 'utf8'));
      }

      const inventory = await readEnvironmentInventory(paths);
      const plan = buildPlan(manifest, lock, inventory, planState, await readLocalSourceDigests(manifest));

      if (opts.json) {
        writeOut(JSON.stringify(plan, null, 2) + '\n');
      } else {
        writeOut(renderPlan(plan));
      }

      setExitCode(planExitCode(plan));
    });

  program
    .command('status [plugin]')
    .description('Display status summary of DSH environment and manifests')
    .action(async (plugin?: string) => {
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
      const plan = buildPlan(manifest, lock, inventory, state, await readLocalSourceDigests(manifest));
      const summary = buildStatus(manifest, lock, state, inventory, plan);
      if (plugin) {
        summary.plugins = summary.plugins.filter(
          (entry) => entry.package === plugin || entry.package.endsWith(`/${plugin}`)
        );
        if (summary.plugins.length === 0) {
          throw new ValidationError(`Plugin not found in status: ${plugin}`);
        }
      }

      if (opts.json) {
        writeOut(JSON.stringify(summary, null, 2) + '\n');
      } else {
        writeOut(renderStatus(summary));
      }

      if (summary.status === 'degraded' || summary.status === 'incompatible') {
        setExitCode(5);
      } else {
        setExitCode(planExitCode(plan));
      }
    });

  program
    .command('doctor')
    .description('Probe DSH runtime and inspect environment readiness')
    .action(async () => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      let manifestHarnessSource: string | undefined;
      let manifestAllowUntested: boolean | undefined;
      if (fs.existsSync(paths.manifestFile)) {
        try {
          const m = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
          manifestHarnessSource = m.environment?.harness?.sourceDir;
          manifestAllowUntested = m.environment?.harness?.allowUntestedVersion;
        } catch {
          // ignore manifest error during doctor probing
        }
      }

      const allowUntested = Boolean(opts.allowUntestedDsh || manifestAllowUntested);
      const compatOpts = { allowUntested };

      const dshCmd = resolveDshCommand({
        cliHarnessSource: opts.harnessSource,
        manifestHarnessSource
      });

      if (!dshCmd) {
        throw new CapabilityError('DSH command could not be resolved from DSH_CLI, harness-source, or PATH');
      }

      const probeResult = await probeDsh(dshCmd);
      const caps = capabilitiesFor(probeResult.version, compatOpts);

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
      const evaluatedCaps = evaluateCapabilities(probeResult.version, evidence, compatOpts);

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
}
