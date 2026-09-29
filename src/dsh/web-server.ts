import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execa } from 'execa';
import type { CommandSpec } from './command.js';
import { CapabilityError, DshError } from '../errors.js';

export interface StartedDshWeb {
  url: string;
  stop(): Promise<void>;
}

export interface LaunchedDshWeb {
  pid: number;
  url: string;
}

export interface LaunchDshWebOptions {
  command: CommandSpec | null;
  dshHome: string;
  // DSH's output goes to this file, not a pipe: dsh web keeps running after dshenv exits.
  logFile: string;
  port?: number;
  timeoutMs?: number;
}

export const DSH_WEB_START_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const POLL_MS = 50;
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;
const POSIX = process.platform !== 'win32';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// On POSIX dsh web leads its own process group, which lives on while what it started (an MCP server, say)
// is still shutting down after DSH itself is gone.
function groupAlive(pid: number): boolean {
  try {
    process.kill(POSIX ? -pid : pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(POSIX ? -pid : pid, signal);
  } catch {
    // Already gone.
  }
}

// Stops dsh web and everything it started, and returns once they are all gone.
export async function stopProcessGroup(pid: number): Promise<void> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    signalGroup(pid, signal);
    const deadline = Date.now() + STOP_GRACE_MS;
    while (groupAlive(pid) && Date.now() < deadline) {
      await sleep(POLL_MS);
    }
    if (!groupAlive(pid)) return;
  }
}

// Whether the dsh web dshenv launched for the profile still runs under this pid; a reused pid is not it.
export async function dshWebRunning(pid: number, profile: string): Promise<boolean> {
  if (!groupAlive(pid)) {
    return false;
  }
  if (!POSIX) {
    return true;
  }
  const leader = await execa('ps', ['-o', 'args=', '-p', String(pid)], { reject: false });
  const args = String(leader.stdout ?? '').trim();
  // The leader can exit before the rest of its group, which still carries this launch's group id.
  return args === '' || args.includes(`--profile ${profile} --no-open --port`);
}

// pnpm echoes the script ("$ node ...") before a source checkout's output and adds an ELIFECYCLE line after it.
function firstErrorLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('$ ') && !line.includes('ELIFECYCLE'));
}

function spawnDshWeb(profile: string, command: CommandSpec, options: LaunchDshWebOptions): ChildProcess {
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true, mode: 0o700 });
  const log = fs.openSync(options.logFile, 'w', 0o600);
  try {
    return spawn(command.file, [...command.args, '--profile', profile, '--no-open', '--port', String(options.port ?? 0)], {
      cwd: command.cwd,
      env: { ...process.env, DSH_HOME: options.dshHome },
      stdio: ['ignore', log, log],
      detached: POSIX,
      windowsHide: true
    });
  } finally {
    fs.closeSync(log);
  }
}

// Starts `dsh --profile <profile>` as dsh web, by default on a free port. The URL carries the login token, so it is
// only returned, never printed; errors quote DSH's own output, never the command line (DSH_CLI can hold credentials).
export async function launchDshWeb(profile: string, options: LaunchDshWebOptions): Promise<LaunchedDshWeb> {
  const { command } = options;
  if (!command) {
    throw new CapabilityError('DSH CLI was not found; configure DSH_CLI or --harness-source');
  }
  const timeoutMs = options.timeoutMs ?? DSH_WEB_START_TIMEOUT_MS;
  const child = spawnDshWeb(profile, command, options);
  let exit: string | undefined;
  child.on('exit', (code) => {
    exit ??= `it exited with code ${String(code)}`;
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    exit ??= `failed to start dsh (${error.code ?? 'spawn error'})`;
  });
  child.unref();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const output = fs.readFileSync(options.logFile, 'utf8');
    const url = URL_PATTERN.exec(output)?.[0];
    if (url && child.pid !== undefined) {
      return { pid: child.pid, url };
    }
    if (exit !== undefined || Date.now() >= deadline) {
      const reason =
        exit !== undefined
          ? `dsh --profile ${profile} did not start dsh web: ${firstErrorLine(output) ?? exit}`
          : `dsh --profile ${profile} did not print a dsh web URL within ${timeoutMs} ms`;
      if (child.pid !== undefined) await stopProcessGroup(child.pid);
      throw new DshError(reason);
    }
    await sleep(POLL_MS);
  }
}

// A dsh web for one check: its log lives in a temporary directory that stop() removes.
export async function startDshWeb(profile: string, options: Omit<LaunchDshWebOptions, 'logFile'>): Promise<StartedDshWeb> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-web-'));
  try {
    const { pid, url } = await launchDshWeb(profile, { ...options, logFile: path.join(dir, 'dsh-web.log') });
    return {
      url,
      stop: async () => {
        await stopProcessGroup(pid);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
