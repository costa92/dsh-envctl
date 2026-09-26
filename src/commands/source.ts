import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadManifest, loadLock, serializeLock, serializeManifest } from '../manifest/files.js';
import { writeAtomic } from '../io/atomic-file.js';
import {
  inspectGitWorkingTree,
  cloneManagedGit,
  safeFastForwardManagedGit,
  managedGitSourceDir,
  packageNameFromGitUrl
} from '../source/git.js';
import { inspectLocalSource } from '../source/local.js';
import { ValidationError } from '../errors.js';
import { loadEffectiveManifest, readOverlay } from '../overlay/effective.js';
import { resolveWriteLayer, saveOverlay, setOverlayPluginFields } from '../overlay/write.js';
import { resolveCliPaths, resolveCliOverlay, type CommandContext } from './context.js';

function overlaySuffix(name: string): string {
  return ` (overlay '${name}')`;
}

export function registerSourceCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;

  const sourceCmd = program.command('source').description('Manage local and Git plugin sources');

  sourceCmd
    .command('status [sourcePath]')
    .description('Inspect working tree and digest status of a source directory')
    .option('-p, --profile <name>', 'inspect the managed clone for this profile')
    .option('--as <alias>', 'manifest alias when --profile is set')
    .action(async (sourcePath?: string, cmdOpts?: { profile?: string; as?: string }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      let targetDir: string;
      if (cmdOpts?.profile) {
        const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
        let alias = cmdOpts.as;
        if (!alias) {
          const gitAliases = Object.entries(manifest.profiles[cmdOpts.profile]?.plugins ?? {})
            .filter(([, plugin]) => plugin.source.type === 'git')
            .map(([name]) => name);
          if (gitAliases.length !== 1) {
            throw new ValidationError('source status --profile requires --as when the profile does not have exactly one git plugin');
          }
          alias = gitAliases[0];
        }
        const plugin = manifest.profiles[cmdOpts.profile]?.plugins[alias];
        if (!plugin || plugin.source.type !== 'git') {
          throw new ValidationError(`Git plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
        }
        targetDir = sourcePath
          ? path.resolve(process.cwd(), sourcePath)
          : managedGitSourceDir(paths.managerDir, cmdOpts.profile, plugin.package);
      } else {
        targetDir = sourcePath ? path.resolve(process.cwd(), sourcePath) : process.cwd();
      }
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
    .command('clone <url> [targetDir]')
    .description('Clone a Git plugin repository; with --profile, store under envctl/sources and lock the commit')
    .option('--ref <ref>', 'branch or tag to clone')
    .option('-p, --profile <name>', 'record the clone as a managed git plugin for this profile')
    .option('--as <alias>', 'manifest alias when --profile is set')
    .option('--layer <layer>', 'layer to write when an overlay is active: base or overlay')
    .action(async (url: string, targetDir: string | undefined, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const packageName = packageNameFromGitUrl(url);
      const alias = cmdOpts.as || packageName;
      let resolvedTarget: string;
      if (targetDir) {
        resolvedTarget = path.resolve(process.cwd(), targetDir);
      } else if (cmdOpts.profile) {
        resolvedTarget = managedGitSourceDir(paths.managerDir, cmdOpts.profile, packageName);
      } else {
        throw new ValidationError('source clone requires <targetDir> or --profile');
      }
      const selection = cmdOpts.profile ? resolveCliOverlay(opts, paths) : null;
      const layer = resolveWriteLayer(selection, cmdOpts.layer);
      const res = await cloneManagedGit(url, resolvedTarget, cmdOpts.ref);

      if (cmdOpts.profile) {
        if (!fs.existsSync(paths.manifestFile)) {
          throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
        }
        if (layer === 'overlay' && selection) {
          const base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
          const baseEntry = base.profiles[cmdOpts.profile]?.plugins[alias];
          if (baseEntry && baseEntry.package !== packageName) {
            throw new ValidationError(`Alias '${alias}' is '${baseEntry.package}' in the base manifest; an overlay cannot change its package`);
          }
          const doc = readOverlay(paths, selection.name);
          setOverlayPluginFields(doc, cmdOpts.profile, alias, baseEntry
            ? { enabled: true, source: { type: 'git', url } }
            : { package: packageName, enabled: true, source: { type: 'git', url } });
          await saveOverlay(paths, selection.name, base, doc);
        } else {
          const manifest = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
          if (!manifest.profiles[cmdOpts.profile]) {
            manifest.profiles[cmdOpts.profile] = { plugins: {} };
          }
          manifest.profiles[cmdOpts.profile].plugins[alias] = {
            package: packageName,
            enabled: true,
            source: { type: 'git', url }
          };
          await writeAtomic(paths.manifestFile, serializeManifest(manifest), 'overwrite');
        }

        const lock = fs.existsSync(paths.lockFile)
          ? loadLock(fs.readFileSync(paths.lockFile, 'utf8'))
          : { apiVersion: 'dshenv-lock/v1' as const, profiles: {} };
        if (!lock.profiles[cmdOpts.profile]) {
          lock.profiles[cmdOpts.profile] = { plugins: {} };
        }
        lock.profiles[cmdOpts.profile].plugins[alias] = {
          package: packageName,
          source: { type: 'git', url, commit: res.commit }
        };
        await writeAtomic(paths.lockFile, serializeLock(lock), 'overwrite');
      }

      const wroteOverlay = Boolean(cmdOpts.profile) && layer === 'overlay' && Boolean(selection);
      if (opts.json) {
        writeOut(JSON.stringify({
          status: 'cloned',
          url,
          target: resolvedTarget,
          commit: res.commit,
          profile: cmdOpts.profile,
          alias,
          ...(wroteOverlay && selection ? { layer: 'overlay', overlay: selection.name } : {})
        }, null, 2) + '\n');
      } else {
        writeOut(`Cloned ${url} to ${resolvedTarget} (HEAD at ${res.commit})${wroteOverlay && selection ? overlaySuffix(selection.name) : ''}\n`);
      }
    });

  sourceCmd
    .command('pull [targetDir] [targetRef]')
    .description('Fast-forward a Git checkout; with --profile, also update the lock commit')
    .option('-p, --profile <name>', 'managed profile whose envctl/sources clone should be updated')
    .option('--as <alias>', 'manifest alias when --profile is set')
    .option('--ref <ref>', 'commit or ref to fast-forward to')
    .action(async (targetDir: string | undefined, targetRef: string | undefined, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const ref = cmdOpts.ref || targetRef;
      if (!ref) {
        throw new ValidationError('source pull requires a ref (--ref or positional targetRef)');
      }

      let resolvedTarget: string;
      let alias: string | undefined;
      let packageName: string | undefined;
      if (cmdOpts.profile) {
        const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
        alias = cmdOpts.as;
        if (!alias) {
          const plugins = manifest.profiles[cmdOpts.profile]?.plugins ?? {};
          const gitAliases = Object.entries(plugins)
            .filter(([, plugin]) => plugin.source.type === 'git')
            .map(([name]) => name);
          if (gitAliases.length !== 1) {
            throw new ValidationError('source pull --profile requires --as when the profile does not have exactly one git plugin');
          }
          alias = gitAliases[0];
        }
        const plugin = manifest.profiles[cmdOpts.profile]?.plugins[alias];
        if (!plugin || plugin.source.type !== 'git') {
          throw new ValidationError(`Git plugin '${alias}' not found in profile '${cmdOpts.profile}'`);
        }
        packageName = plugin.package;
        resolvedTarget = targetDir
          ? path.resolve(process.cwd(), targetDir)
          : managedGitSourceDir(paths.managerDir, cmdOpts.profile, packageName);
      } else if (targetDir) {
        resolvedTarget = path.resolve(process.cwd(), targetDir);
      } else {
        throw new ValidationError('source pull requires <targetDir> or --profile');
      }

      const res = await safeFastForwardManagedGit(resolvedTarget, ref);

      if (cmdOpts.profile && alias && fs.existsSync(paths.lockFile)) {
        const lock = loadLock(fs.readFileSync(paths.lockFile, 'utf8'));
        const lockPlugin = lock.profiles[cmdOpts.profile]?.plugins[alias];
        if (lockPlugin?.source.type === 'git') {
          lockPlugin.source = { ...lockPlugin.source, commit: res.newCommit };
          await writeAtomic(paths.lockFile, serializeLock(lock), 'overwrite');
        }
      }

      if (opts.json) {
        writeOut(JSON.stringify({
          status: 'pulled',
          target: resolvedTarget,
          profile: cmdOpts.profile,
          alias,
          ...res
        }, null, 2) + '\n');
      } else {
        writeOut(`Updated ${resolvedTarget} from ${res.previousCommit} to ${res.newCommit}\n`);
      }
    });
}
