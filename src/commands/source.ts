import * as crypto from 'node:crypto';
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
import { mergeManifest } from '../overlay/merge.js';
import { loadEffectiveManifest, readOverlay } from '../overlay/effective.js';
import { acquireEnvironmentLock, withEnvironmentLock } from '../io/lock.js';
import { hasEmbeddedCredentials } from '../manifest/schema.js';
import { readPackageJsonName } from '../source/local.js';
import { assertLockEntryNotRemoteOwned, assertNotRemoteOwned } from '../remote/ownership.js';
import { assertBaseMergesWithOverlay, resolveWriteLayer, saveOverlay, setOverlayPluginFields } from '../overlay/write.js';
import { resolveCliPaths, resolveCliOverlay, profileOption, aliasOption, type CommandContext } from './context.js';

function overlaySuffix(name: string): string {
  return ` (overlay '${name}')`;
}

export function registerSourceCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;

  const sourceCmd = program.command('source').description('Manage local and Git plugin sources');

  sourceCmd
    .command('status [sourcePath]')
    .description('Inspect working tree and digest status of a source directory')
    .option('-p, --profile <name>', 'inspect the managed clone for this profile', profileOption)
    .option('--as <alias>', 'manifest alias when --profile is set', aliasOption)
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
    .option('-p, --profile <name>', 'record the clone as a managed git plugin for this profile', profileOption)
    .option('--as <alias>', 'manifest alias when --profile is set', aliasOption)
    .option('--package <name>', 'package name when --profile is set; defaults to the cloned package.json name')
    .option('--layer <layer>', 'layer to write when an overlay is active: base or overlay')
    .action(async (url: string, targetDir: string | undefined, cmdOpts) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      // git would also keep such a URL in the clone's .git/config, so refuse it even without --profile.
      if (hasEmbeddedCredentials(url)) {
        throw new ValidationError('Git URL must not embed credentials; use SSH or a git credential helper');
      }
      const alias: string = cmdOpts.as || packageNameFromGitUrl(url);
      if (!targetDir && !cmdOpts.profile) {
        throw new ValidationError('source clone requires <targetDir> or --profile');
      }
      if (!cmdOpts.profile && cmdOpts.layer !== undefined) {
        throw new ValidationError('--layer requires --profile for source clone');
      }
      const selection = cmdOpts.profile ? resolveCliOverlay(opts, paths) : null;
      const layer = resolveWriteLayer(selection, cmdOpts.layer);
      const explicitTarget = targetDir ? path.resolve(process.cwd(), targetDir) : null;
      const sourcesDir = path.join(paths.managerDir, 'sources');
      // A managed clone is named after its package, which is only known once cloned, so it lands in a staging dir first.
      const cloneDir = explicitTarget ?? path.join(sourcesDir, `.staging-${crypto.randomBytes(6).toString('hex')}`);
      const createdDirs = (explicitTarget ? [cloneDir] : [cloneDir, sourcesDir]).filter((dir) => !fs.existsSync(dir));

      // Hold the lock from reading the manifest until the lock file is written, cloning included.
      const lockHandle = cmdOpts.profile ? await acquireEnvironmentLock(paths) : null;
      let res: Awaited<ReturnType<typeof cloneManagedGit>>;
      let resolvedTarget = cloneDir;
      try {
        if (cmdOpts.profile && !fs.existsSync(paths.manifestFile)) {
          throw new ValidationError(`Manifest file not found: ${paths.manifestFile}`);
        }
        if (cmdOpts.profile) {
          // Refuse before cloning: this command writes the alias's lock entry, and the base unless it targets the overlay.
          assertLockEntryNotRemoteOwned(paths, cmdOpts.profile, alias);
          if (layer !== 'overlay') {
            assertNotRemoteOwned(paths, paths.manifestFile);
          }
        }
        res = await cloneManagedGit(url, cloneDir, cmdOpts.ref);

        if (cmdOpts.profile) {
          const profile: string = cmdOpts.profile;
          const packageName: string = cmdOpts.package ?? readPackageJsonName(cloneDir) ?? packageNameFromGitUrl(url);
          let writeManifest: () => Promise<void>;
          const base = loadManifest(fs.readFileSync(paths.manifestFile, 'utf8'));
          if (layer === 'overlay' && selection) {
            const overlayDoc = readOverlay(paths, selection.name);
            const baseEntry = base.profiles[profile]?.plugins[alias];
            if (baseEntry && baseEntry.package !== packageName) {
              throw new ValidationError(`Alias '${alias}' is '${baseEntry.package}' in the base manifest; an overlay cannot change its package`);
            }
            const overlayEntry = overlayDoc.profiles?.[profile]?.plugins?.[alias];
            const exists = overlayEntry ? !overlayEntry.remove : Boolean(baseEntry);
            setOverlayPluginFields(overlayDoc, profile, alias, exists
              ? { source: { type: 'git', url } }
              : baseEntry
                ? { enabled: true, source: { type: 'git', url } }
                : { package: packageName, enabled: true, source: { type: 'git', url } });
            mergeManifest(base, overlayDoc, selection.name);
            writeManifest = () => saveOverlay(paths, selection.name, base, overlayDoc);
          } else {
            if (!base.profiles[profile]) {
              base.profiles[profile] = { plugins: {} };
            }
            const current = base.profiles[profile].plugins[alias];
            base.profiles[profile].plugins[alias] = current?.package === packageName
              ? { ...current, source: { type: 'git', url } }
              : { package: packageName, enabled: true, source: { type: 'git', url } };
            assertBaseMergesWithOverlay(paths, selection, base);
            writeManifest = () => writeAtomic(paths.manifestFile, serializeManifest(base), 'overwrite');
          }

          if (!explicitTarget) {
            const managedDir = managedGitSourceDir(paths.managerDir, profile, packageName);
            if (fs.existsSync(managedDir)) {
              throw new ValidationError(`Managed source already exists: ${managedDir}`);
            }
            if (!fs.existsSync(path.dirname(managedDir))) {
              createdDirs.push(path.dirname(managedDir));
            }
            await fs.promises.mkdir(path.dirname(managedDir), { recursive: true });
            await fs.promises.rename(cloneDir, managedDir);
            createdDirs[0] = managedDir;
            resolvedTarget = managedDir;
          }

          await writeManifest();

          const lock = fs.existsSync(paths.lockFile)
            ? loadLock(fs.readFileSync(paths.lockFile, 'utf8'))
            : { apiVersion: 'dshenv-lock/v1' as const, profiles: {} };
          if (!lock.profiles[profile]) {
            lock.profiles[profile] = { plugins: {} };
          }
          lock.profiles[profile].plugins[alias] = {
            package: packageName,
            source: { type: 'git', url, commit: res.commit }
          };
          await writeAtomic(paths.lockFile, serializeLock(lock), 'overwrite');
        }
      } catch (err) {
        // Leave nothing behind that this command created: the clone and any directories made for it.
        for (const dir of createdDirs) {
          await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
        throw err;
      } finally {
        await lockHandle?.release();
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
    .option('-p, --profile <name>', 'managed profile whose envctl/sources clone should be updated', profileOption)
    .option('--as <alias>', 'manifest alias when --profile is set', aliasOption)
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

      if (cmdOpts.profile && alias) {
        // The lock entry is rewritten after the fast-forward, so refuse before touching the checkout.
        assertLockEntryNotRemoteOwned(paths, cmdOpts.profile, alias);
      }

      const res = await safeFastForwardManagedGit(resolvedTarget, ref);

      if (cmdOpts.profile && alias) {
        const profile: string = cmdOpts.profile;
        const pluginAlias = alias;
        await withEnvironmentLock(paths, async () => {
          if (!fs.existsSync(paths.lockFile)) {
            return;
          }
          const lock = loadLock(fs.readFileSync(paths.lockFile, 'utf8'));
          const lockPlugin = lock.profiles[profile]?.plugins[pluginAlias];
          if (lockPlugin?.source.type === 'git') {
            lockPlugin.source = { ...lockPlugin.source, commit: res.newCommit };
            await writeAtomic(paths.lockFile, serializeLock(lock), 'overwrite');
          }
        });
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
