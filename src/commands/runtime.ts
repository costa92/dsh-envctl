import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentManifest } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import { DshError, ValidationError } from '../errors.js';
import { loadState } from '../manifest/files.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import { renderRuntimeReport } from '../output/render.js';
import { callDshWeb, DSH_URL_ENV, loginDshWeb, parseDshWebUrl } from '../dsh/web-client.js';
import {
  checkRuntime,
  parseRuntimeBundles,
  parseRuntimePlugins,
  runtimeExitCode,
  type DeclaredPlugin,
  type RuntimeBundle
} from '../runtime/compare.js';
import { resolveCliPaths, resolveCliOverlay, profileOption, type CommandContext } from './context.js';

function selectProfile(manifest: EnvironmentManifest, requested: string | undefined): string {
  const names = Object.keys(manifest.profiles);
  if (requested !== undefined) {
    if (!names.includes(requested)) {
      throw new ValidationError(`Profile '${requested}' is not declared in the manifest`);
    }
    return requested;
  }
  if (names.length === 1) {
    return names[0];
  }
  throw new ValidationError(
    names.length === 0 ? 'The manifest declares no profiles' : `The manifest declares several profiles (${names.join(', ')}); pass --profile`
  );
}

// DSH does not say which profile it runs; listBundles reads that profile's package.json, so the packages must agree.
function assertSameProfile(
  paths: EnvironmentPaths,
  profile: string,
  declaredPackages: string[],
  bundles: RuntimeBundle[],
  endpoint: string
): void {
  const file = path.join(paths.profilesDir, profile, 'package.json');
  if (!fs.existsSync(file)) {
    throw new DshError(`Profile ${profile} has no package.json at ${file}; cannot tell whether DSH at ${endpoint} runs it`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { dependencies?: unknown };
  const dependencies = new Set(
    raw.dependencies !== null && typeof raw.dependencies === 'object' ? Object.keys(raw.dependencies as object) : []
  );
  const running = new Set(bundles.map((bundle) => bundle.name));
  const foreign = bundles.some((bundle) => bundle.installed && !dependencies.has(bundle.name));
  const unseen = declaredPackages.some((name) => dependencies.has(name) && !running.has(name));
  if (foreign || unseen) {
    throw new DshError(
      `DSH at ${endpoint} does not look like profile ${profile}: its installed packages differ from ${file}; ${DSH_URL_ENV} may point at the dsh web of another profile or DSH home`
    );
  }
}

export function registerRuntimeCommand(ctx: CommandContext): void {
  const { program, writeOut, setExitCode } = ctx;

  program
    .command('runtime')
    .description(`Ask a running dsh web (${DSH_URL_ENV}) whether the declared plugins are loaded`)
    .option('-p, --profile <name>', 'profile to check', profileOption)
    .option('--allow-remote', 'allow sending the dsh web token to a non-loopback host')
    .action(async (cmdOpts: { profile?: string; allowRemote?: boolean }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
      const profile = selectProfile(manifest, cmdOpts.profile);
      const target = parseDshWebUrl(process.env[DSH_URL_ENV], { allowRemote: Boolean(cmdOpts.allowRemote) });

      const session = await loginDshWeb(target);
      const bundles = parseRuntimeBundles(await callDshWeb(session, 'pluginManager', 'listBundles'), target.endpoint);
      const plugins = parseRuntimePlugins(await callDshWeb(session, 'pluginManager', 'listPlugins'), target.endpoint);

      const entries = Object.entries(manifest.profiles[profile]?.plugins ?? {});
      assertSameProfile(paths, profile, entries.map(([, plugin]) => plugin.package), bundles, target.endpoint);

      const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
      const declared: DeclaredPlugin[] = entries.map(([alias, plugin]) => ({
        alias,
        package: plugin.package,
        enabled: plugin.enabled !== false,
        restartRequired: state?.profiles[profile]?.plugins[plugin.package]?.status === 'restart-required'
      }));
      const results = checkRuntime(declared, bundles, plugins);

      if (opts.json) {
        writeOut(JSON.stringify({ profile, endpoint: target.endpoint, results }, null, 2) + '\n');
      } else {
        writeOut(renderRuntimeReport(profile, target.endpoint, results));
      }
      setExitCode(runtimeExitCode(results));
    });
}
