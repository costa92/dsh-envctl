import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnvironmentPaths } from '../environment/paths.js';
import { ValidationError } from '../errors.js';
import { resolveDshCommand } from '../dsh/command.js';
import { DSH_WEB_START_TIMEOUT_MS, dshWebRunning, launchDshWeb, stopProcessGroup } from '../dsh/web-server.js';
import { acquireFileLock } from '../io/lock.js';
import { listWebRecords, readWebRecord, removeWebRecord, webLogFile, writeWebRecord, type DshWebRecord } from '../dsh/web-record.js';
import { parseDshWebUrl } from '../dsh/web-client.js';
import { loadEffectiveManifest } from '../overlay/effective.js';
import { resolveCliOverlay, resolveCliPaths, type CommandContext } from './context.js';

interface CliOpts {
  dshHome?: string;
  harnessSource?: string;
  overlay?: string | false;
  json?: boolean;
}

const PROFILE_NAME = /^[-A-Za-z0-9._]+$/;

// The name becomes a directory under profiles/ and a file under envctl/run/, so it must stay inside both.
function webProfileOption(value: string): string {
  if (!PROFILE_NAME.test(value) || value === '.' || value === '..') {
    throw new ValidationError(`Invalid profile name: ${value}`);
  }
  return value;
}

// dsh creates a profile it is started with, which starting or checking dsh web must not do.
export function assertProfileExists(paths: EnvironmentPaths, profile: string): void {
  webProfileOption(profile);
  if (!fs.existsSync(path.join(paths.profilesDir, profile, 'package.json'))) {
    throw new ValidationError(`Profile '${profile}' does not exist; start DSH with --profile ${profile} once`);
  }
}

export function resolveCliDshCommand(paths: EnvironmentPaths, opts: CliOpts) {
  const manifestSource = fs.existsSync(paths.manifestFile)
    ? loadEffectiveManifest(paths, resolveCliOverlay(opts, paths)).manifest.environment?.harness?.sourceDir
    : undefined;
  return resolveDshCommand({ cliHarnessSource: opts.harnessSource, manifestHarnessSource: manifestSource });
}

// The dsh web `dshenv web start` left running for the profile, or null when there is none or it has stopped.
export async function runningWebRecord(paths: EnvironmentPaths, profile: string): Promise<DshWebRecord | null> {
  const record = readWebRecord(paths, profile);
  return record && (await dshWebRunning(record.pid, profile)) ? record : null;
}

function portOption(value: string): number {
  const port = Number(value);
  if (!/^\d+$/.test(value) || port > 65535) {
    throw new ValidationError('--port must be an integer from 0 to 65535 (0 picks a free port)');
  }
  return port;
}

const endpointOf = (record: DshWebRecord): string => parseDshWebUrl(record.url).endpoint;

// One start or stop per profile at a time, so two starts cannot both launch dsh web; a start holds it until DSH is up.
async function withProfileLock<T>(paths: EnvironmentPaths, profile: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
  const lock = await acquireFileLock(path.join(paths.runDir, `${profile}.lock`), `dsh web lock for profile ${profile}`, DSH_WEB_START_TIMEOUT_MS + 15_000);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export function registerWebCommands(ctx: CommandContext): void {
  const { program, writeOut } = ctx;
  const web = program.command('web').description('Start, stop and list dsh web servers that keep running in the background');

  web
    .command('start')
    .description('Start dsh web for a profile in the background and print its URL')
    .requiredOption('-p, --profile <name>', 'profile to serve', webProfileOption)
    .option('--port <port>', 'port to listen on; 0 picks a free one', '0')
    .action(async (cmdOpts: { profile: string; port: string }) => {
      const opts = program.opts<CliOpts>();
      const port = portOption(cmdOpts.port);
      const paths = resolveCliPaths(opts);
      const { profile } = cmdOpts;
      assertProfileExists(paths, profile);

      await withProfileLock(paths, profile, async () => {
        const current = await runningWebRecord(paths, profile);
        if (current) {
          if (opts.json) {
            writeOut(JSON.stringify({ status: 'running', ...current, endpoint: endpointOf(current) }, null, 2) + '\n');
          } else {
            writeOut(`dsh web for profile ${profile} is already running (pid ${current.pid})\n  URL: ${current.url}\n`);
          }
          return;
        }
        removeWebRecord(paths, profile);
        const logFile = webLogFile(paths, profile);
        const launched = await launchDshWeb(profile, { command: resolveCliDshCommand(paths, opts), dshHome: paths.home, logFile, port });
        const record: DshWebRecord = { profile, pid: launched.pid, url: launched.url, logFile, startedAt: new Date().toISOString() };
        writeWebRecord(paths, record);
        if (opts.json) {
          writeOut(JSON.stringify({ status: 'started', ...record, endpoint: endpointOf(record) }, null, 2) + '\n');
        } else {
          writeOut(
            `Started dsh web for profile ${profile} (pid ${record.pid})\n  URL: ${record.url}\n  Log: ${logFile}\nStop it with: dshenv web stop -p ${profile}\n`
          );
        }
      });
    });

  web
    .command('stop')
    .description('Stop the dsh web that dshenv web start left running for a profile, with everything it started')
    .requiredOption('-p, --profile <name>', 'profile whose dsh web to stop', webProfileOption)
    .action(async (cmdOpts: { profile: string }) => {
      const opts = program.opts<CliOpts>();
      const paths = resolveCliPaths(opts);
      const { profile } = cmdOpts;
      const record = await withProfileLock(paths, profile, async () => {
        const running = await runningWebRecord(paths, profile);
        if (running) {
          await stopProcessGroup(running.pid);
        }
        removeWebRecord(paths, profile);
        return running;
      });
      if (opts.json) {
        writeOut(JSON.stringify({ profile, status: record ? 'stopped' : 'not-running', ...(record ? { pid: record.pid } : {}) }, null, 2) + '\n');
      } else {
        writeOut(record ? `Stopped dsh web for profile ${profile} (pid ${record.pid})\n` : `No dsh web started by dshenv is running for profile ${profile}.\n`);
      }
    });

  web
    .command('status')
    .description('List the dsh web servers dshenv web start left running (never their token)')
    .action(async () => {
      const opts = program.opts<CliOpts>();
      const paths = resolveCliPaths(opts);
      const webs = await Promise.all(
        listWebRecords(paths).map(async (record) => {
          const running = await dshWebRunning(record.pid, record.profile);
          return { profile: record.profile, pid: record.pid, running, endpoint: endpointOf(record), startedAt: record.startedAt, logFile: record.logFile };
        })
      );
      if (opts.json) {
        writeOut(JSON.stringify({ webs }, null, 2) + '\n');
        return;
      }
      if (webs.length === 0) {
        writeOut('No dsh web started by dshenv.\n');
        return;
      }
      for (const entry of webs) {
        writeOut(entry.running ? `${entry.profile}  running  pid ${entry.pid}  ${entry.endpoint}\n` : `${entry.profile}  not running  pid ${entry.pid}\n`);
      }
    });
}
