import * as fs from 'node:fs';
import * as path from 'node:path';
import { readEnvironmentInventory } from '../inventory/profile-reader.js';
import type { EnvironmentManifest } from '../domain.js';
import type { EnvironmentPaths } from '../environment/paths.js';
import { DshError, ValidationError } from '../errors.js';
import { loadState } from '../manifest/files.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import { renderRuntimeReport } from '../output/render.js';
import { callDshWeb, DSH_URL_ENV, loginDshWeb, parseDshWebUrl, type DshWebTarget } from '../dsh/web-client.js';
import { startDshWeb } from '../dsh/web-server.js';
import { assertProfileExists, resolveCliDshCommand, runningWebRecord } from './web.js';
import {
  checkRuntime,
  parseRuntimeBundles,
  parseRuntimePlugins,
  runtimeExitCode,
  type DeclaredPlugin,
  type RuntimeBundle
} from '../runtime/compare.js';
import { resolveCliPaths, resolveCliOverlay, profileOption, profileFromEnv, missingProfileError, TARGET_PROFILE_HELP, type CommandContext } from './context.js';

// -p, else DSHENV_PROFILE, else the only declared profile.
function selectProfile(paths: EnvironmentPaths, opts: { overlay?: string | false }, manifest: EnvironmentManifest, requested: string | undefined): string {
  const names = Object.keys(manifest.profiles);
  const named = requested ?? profileFromEnv();
  if (named !== undefined) {
    if (!names.includes(named)) {
      throw new ValidationError(`Profile '${named}' is not declared in the manifest`);
    }
    return named;
  }
  if (names.length === 1) {
    return names[0];
  }
  throw missingProfileError(paths, opts);
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
  let raw: { dependencies?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { dependencies?: unknown };
  } catch {
    throw new DshError(`Profile ${profile} package.json is not valid JSON: ${file}`);
  }
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
    .option('-p, --profile <name>', TARGET_PROFILE_HELP, profileOption)
    .option('--allow-remote', 'allow sending the dsh web token to a non-loopback https host')
    .option('--start', `start dsh web for the profile, check it and stop it again, instead of using ${DSH_URL_ENV}`)
    .action(async (cmdOpts: { profile?: string; allowRemote?: boolean; start?: boolean }) => {
      const opts = program.opts();
      const paths = resolveCliPaths(opts);
      const manifest = loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest;
      const profile = selectProfile(paths, opts, manifest, cmdOpts.profile);
      if (!cmdOpts.start) {
        const url = process.env[DSH_URL_ENV]?.trim() ? process.env[DSH_URL_ENV] : (await runningWebRecord(paths, profile))?.url;
        if (url === undefined) {
          throw new ValidationError(
            `${DSH_URL_ENV} is not set and no dsh web started by 'dshenv web start' is running for profile ${profile}; export the URL dsh web printed, run dshenv web start -p ${profile}, or pass --start`
          );
        }
        await checkProfile(paths, manifest, profile, parseDshWebUrl(url, { allowRemote: Boolean(cmdOpts.allowRemote) }), opts.json);
        return;
      }
      if (cmdOpts.allowRemote) {
        throw new ValidationError('--start and --allow-remote cannot be combined: --start checks the dsh web it starts on this machine');
      }
      assertProfileExists(paths, profile);
      const web = await startDshWeb(profile, { command: resolveCliDshCommand(paths, opts), dshHome: paths.home });
      try {
        await checkProfile(paths, manifest, profile, parseDshWebUrl(web.url), opts.json);
      } finally {
        await web.stop();
      }
    });

  async function checkProfile(
    paths: EnvironmentPaths,
    manifest: EnvironmentManifest,
    profile: string,
    target: DshWebTarget,
    json: boolean | undefined
  ): Promise<void> {
    const session = await loginDshWeb(target);
    const bundles = parseRuntimeBundles(await callDshWeb(session, 'pluginManager', 'listBundles'), target.endpoint);
    const plugins = parseRuntimePlugins(await callDshWeb(session, 'pluginManager', 'listPlugins'), target.endpoint);

    const entries = Object.entries(manifest.profiles[profile]?.plugins ?? {});
    const installed = (await readEnvironmentInventory(paths)).profiles[profile]?.plugins ?? {};
    // A mounted plugin is in no bundle, so listBundles cannot show it.
    const enabledPackages = entries
      .filter(([, plugin]) => plugin.enabled !== false && installed[plugin.package]?.bundle !== false)
      .map(([, plugin]) => plugin.package);
    assertSameProfile(paths, profile, enabledPackages, bundles, target.endpoint);

    const state = fs.existsSync(paths.stateFile) ? loadState(fs.readFileSync(paths.stateFile, 'utf8')) : null;
    const declared: DeclaredPlugin[] = entries.map(([alias, plugin]) => ({
      alias,
      package: plugin.package,
      enabled: plugin.enabled !== false,
      restartRequired: state?.profiles[profile]?.plugins[plugin.package]?.status === 'restart-required',
      ...(installed[plugin.package]?.bundle === false ? { mounted: true } : {})
    }));
    const results = checkRuntime(declared, bundles, plugins);

    if (json) {
      writeOut(JSON.stringify({ profile, endpoint: target.endpoint, results }, null, 2) + '\n');
    } else {
      writeOut(renderRuntimeReport(profile, target.endpoint, results));
    }
    setExitCode(runtimeExitCode(results));
  }
}
