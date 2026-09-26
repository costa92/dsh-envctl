import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveEnvironmentPaths } from './environment/paths.js';
import { readEnvironmentInventory } from './inventory/profile-reader.js';
import { captureEnvironment, initEnvironment } from './capture/capture.js';
import { adoptEnvironment } from './adopt/adopt.js';
import { applyEnvironment } from './apply/apply.js';
import {
  loadManifest,
  loadLock,
  loadState,
  parseYamlStrict,
  serializeCaptureDocument,
  serializeManifest
} from './manifest/files.js';
import { CaptureDocumentSchema } from './manifest/schema.js';
import { buildPlan, buildStatus, planExitCode } from './planner/plan.js';
import { renderPlan, renderStatus, renderDoctor, type DoctorReport } from './output/render.js';
import { writeAtomic } from './io/atomic-file.js';
import { resolveDshCommand, probeDsh, capabilitiesFor, evaluateCapabilities, probeOfficialSurfaces, type RuntimeCapabilityEvidence } from './dsh/index.js';
import { inspectGitWorkingTree, cloneManagedGit, safeFastForwardManagedGit } from './source/git.js';
import { inspectLocalSource, calculateSourceDigest } from './source/local.js';
import { applyPatchBlock, removePatchBlock, extractManagedPatches } from './patch/patch.js';
import { DshError, ValidationError, CapabilityError } from './errors.js';
import type { EnvironmentManifest, EnvironmentLock, EnvironmentState, CaptureDocument, PluginSource } from './domain.js';
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
    .option('--allow-untested-dsh', 'allow untested or experimental DSH runtime versions')
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
    .command('adopt')
    .description('Adopt a candidate capture manifest into active environment management')
    .requiredOption('-f, --from <file>', 'path to candidate capture manifest')
    .option('-y, --yes', 'skip confirmation')
    .action(async (cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

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

      const res = await applyEnvironment(paths, {
        dryRun: Boolean(cmdOpts.dryRun),
        allowUntested,
        harnessSource: opts.harnessSource
      });

      if (opts.json) {
        writeOut(JSON.stringify(res, null, 2) + '\n');
      } else {
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
      const plan = buildPlan(manifest, lock, inventory, planState);

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
      const plan = buildPlan(manifest, lock, inventory, state);
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

  function parsePluginSpec(spec: string, optsAlias?: string): { alias: string; packageName: string; source: PluginSource } {
    if (spec.startsWith('git+') || spec.startsWith('http://') || spec.startsWith('https://') || spec.startsWith('git@') || spec.endsWith('.git')) {
      const cleanUrl = spec.startsWith('git+') ? spec.slice(4) : spec;
      const urlParts = cleanUrl.split('#');
      const repoUrl = urlParts[0];
      const commitOrRef = urlParts[1];
      const baseName = path.basename(repoUrl, '.git');
      const alias = optsAlias || baseName.replace(/^(dsh-plugin-|dsh-)/, '');
      return {
        alias,
        packageName: baseName,
        source: {
          type: 'git',
          url: repoUrl,
          commit: commitOrRef
        }
      };
    }

    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || spec.startsWith('file:')) {
      const localPath = spec.startsWith('file:') ? spec.slice(5) : spec;
      const resolved = path.resolve(localPath);
      const baseName = path.basename(resolved);
      const alias = optsAlias || baseName.replace(/^(dsh-plugin-|dsh-)/, '');
      return {
        alias,
        packageName: baseName,
        source: {
          type: 'local-link',
          path: resolved
        }
      };
    }

    let packageName = spec;
    let version = '*';

    if (spec.startsWith('@')) {
      const atIdx = spec.indexOf('@', 1);
      if (atIdx !== -1) {
        packageName = spec.slice(0, atIdx);
        version = spec.slice(atIdx + 1);
      }
    } else {
      const atIdx = spec.indexOf('@');
      if (atIdx !== -1) {
        packageName = spec.slice(0, atIdx);
        version = spec.slice(atIdx + 1);
      }
    }

    const simpleName = packageName.startsWith('@') ? packageName.split('/')[1] : packageName;
    const alias = optsAlias || simpleName.replace(/^(dsh-plugin-|dsh-)/, '');

    return {
      alias,
      packageName,
      source: {
        type: 'npm',
        version
      }
    };
  }

  program
    .command('install <spec>')
    .description('Install a plugin into the manifest for a profile')
    .requiredOption('-p, --profile <name>', 'target profile')
    .option('--as <alias>', 'custom alias name for the plugin')
    .action(async (spec: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      if (!fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}. Run dshenv init first.`);
      }

      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      if (!manifest.profiles[cmdOpts.profile]) {
        manifest.profiles[cmdOpts.profile] = { plugins: {} };
      }

      const parsed = parsePluginSpec(spec, cmdOpts.as);
      manifest.profiles[cmdOpts.profile].plugins[parsed.alias] = {
        package: parsed.packageName,
        enabled: true,
        source: parsed.source
      };

      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');

      if (opts.json) {
        writeOut(JSON.stringify({ status: 'installed', profile: cmdOpts.profile, alias: parsed.alias, package: parsed.packageName, source: parsed.source }, null, 2) + '\n');
      } else {
        writeOut(`Installed ${parsed.packageName} (${parsed.alias}) in profile '${cmdOpts.profile}'.\n`);
      }
    });

  program
    .command('enable <alias>')
    .description('Enable an installed plugin in a profile')
    .requiredOption('-p, --profile <name>', 'target profile')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      if (!fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
      }

      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      const profile = manifest.profiles[cmdOpts.profile];
      if (!profile || !profile.plugins[alias]) {
        throw new ValidationError(`Plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
      }

      profile.plugins[alias].enabled = true;
      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');

      if (opts.json) {
        writeOut(JSON.stringify({ status: 'enabled', profile: cmdOpts.profile, alias }, null, 2) + '\n');
      } else {
        writeOut(`Enabled plugin '${alias}' in profile '${cmdOpts.profile}'.\n`);
      }
    });

  program
    .command('disable <alias>')
    .description('Disable an installed plugin in a profile')
    .requiredOption('-p, --profile <name>', 'target profile')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      if (!fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
      }

      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      const profile = manifest.profiles[cmdOpts.profile];
      if (!profile || !profile.plugins[alias]) {
        throw new ValidationError(`Plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
      }

      profile.plugins[alias].enabled = false;
      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');

      if (opts.json) {
        writeOut(JSON.stringify({ status: 'disabled', profile: cmdOpts.profile, alias }, null, 2) + '\n');
      } else {
        writeOut(`Disabled plugin '${alias}' in profile '${cmdOpts.profile}'.\n`);
      }
    });

  program
    .command('remove <alias>')
    .description('Remove an installed plugin from a profile')
    .requiredOption('-p, --profile <name>', 'target profile')
    .option('-y, --yes', 'skip confirmation')
    .action(async (alias: string, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);

      if (!fs.existsSync(paths.manifestFile)) {
        throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
      }

      const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
      const profile = manifest.profiles[cmdOpts.profile];
      if (!profile || !profile.plugins[alias]) {
        throw new ValidationError(`Plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
      }

      delete profile.plugins[alias];
      await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');

      if (opts.json) {
        writeOut(JSON.stringify({ status: 'removed', profile: cmdOpts.profile, alias }, null, 2) + '\n');
      } else {
        writeOut(`Removed plugin '${alias}' from profile '${cmdOpts.profile}'.\n`);
      }
    });

  const sourceCmd = program.command('source').description('Manage local and Git plugin sources');

  sourceCmd
    .command('status [sourcePath]')
    .description('Inspect working tree and digest status of a source directory')
    .action(async (sourcePath?: string) => {
      const opts = program.opts();
      const targetDir = sourcePath ? path.resolve(process.cwd(), sourcePath) : process.cwd();
      const gitStatus = await inspectGitWorkingTree(targetDir);
      let localInfo: unknown = null;
      try {
        localInfo = await inspectLocalSource(targetDir);
      } catch {
        // Not a standard plugin source dir
      }

      const result = {
        dir: targetDir,
        git: gitStatus,
        local: localInfo
      };

      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
      } else {
        writeOut(`Source: ${targetDir}\n`);
        writeOut(`  Git Repo: ${gitStatus.isGitRepo ? 'Yes' : 'No'}\n`);
        if (gitStatus.isGitRepo) {
          writeOut(`  Dirty: ${gitStatus.isDirty ? 'Yes (uncommitted changes)' : 'No'}\n`);
          writeOut(`  Commit: ${gitStatus.commit ?? 'unknown'}\n`);
          if (gitStatus.branch) {
            writeOut(`  Branch: ${gitStatus.branch}\n`);
          }
        }
      }
    });

  sourceCmd
    .command('clone <url> <targetDir>')
    .description('Clone a Git plugin repository safely')
    .option('--ref <ref>', 'branch or tag to clone')
    .action(async (url: string, targetDir: string, cmdOpts) => {
      const opts = program.opts();
      const resolvedTarget = path.resolve(process.cwd(), targetDir);
      const res = await cloneManagedGit(url, resolvedTarget, cmdOpts.ref);
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'cloned', url, target: resolvedTarget, commit: res.commit }, null, 2) + '\n');
      } else {
        writeOut(`Cloned ${url} to ${resolvedTarget} (HEAD at ${res.commit})\n`);
      }
    });

  sourceCmd
    .command('pull <targetDir> <targetRef>')
    .description('Fast-forward update a managed Git plugin repository')
    .action(async (targetDir: string, targetRef: string) => {
      const opts = program.opts();
      const resolvedTarget = path.resolve(process.cwd(), targetDir);
      const res = await safeFastForwardManagedGit(resolvedTarget, targetRef);
      if (opts.json) {
        writeOut(JSON.stringify({ status: 'pulled', target: resolvedTarget, ...res }, null, 2) + '\n');
      } else {
        writeOut(`Updated ${resolvedTarget} from ${res.previousCommit} to ${res.newCommit}\n`);
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
