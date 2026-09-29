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
  // When the leader started; a later process that reuses its pid started at another time.
  leaderStart: string;
}

// leftover: the leader is gone, but processes it started still run in its process group.
export type DshWebState = 'running' | 'leftover' | 'stopped' | 'unknown';

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
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

// Stops dsh web and everything it started; false when some of it still runs after SIGKILL.
export async function stopProcessGroup(pid: number): Promise<boolean> {
  // Windows has no process groups; taskkill /T takes the whole tree (cmd.exe shim, node, MCP servers). Without /F it
  // only asks windowless console processes to close, which they never do.
  const rounds = POSIX
    ? (['SIGTERM', 'SIGKILL'] as const).map((signal) => async () => signalGroup(pid, signal))
    : [async () => void (await execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false, windowsHide: true }))];
  for (const round of rounds) {
    await round();
    const deadline = Date.now() + STOP_GRACE_MS;
    while (groupAlive(pid) && Date.now() < deadline) {
      await sleep(POLL_MS);
    }
    if (!groupAlive(pid)) return true;
  }
  return false;
}

// Ctrl-C ends dshenv without running async cleanup, and a detached dsh web would outlive it. One handler runs
// every registered cleanup to the end (SIGTERM, then SIGKILL) and then lets the signal end dshenv as it would have;
// a second Ctrl-C meanwhile ends dshenv at once.
const INTERRUPTS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const interruptCleanups = new Set<() => Promise<void>>();
let interrupting = false;

function onInterrupt(signal: NodeJS.Signals): void {
  interrupting = true;
  for (const name of INTERRUPTS) process.off(name, onInterrupt);
  const cleanups = [...interruptCleanups];
  interruptCleanups.clear();
  void Promise.allSettled(cleanups.map((cleanup) => cleanup())).then(() => process.kill(process.pid, signal));
}

// Registers a cleanup to run if dshenv is interrupted; the returned function unregisters it.
export function stopOnInterrupt(cleanup: () => Promise<void>): () => void {
  if (interruptCleanups.size === 0) {
    for (const name of INTERRUPTS) process.on(name, onInterrupt);
  }
  interruptCleanups.add(cleanup);
  return () => {
    interruptCleanups.delete(cleanup);
    if (interruptCleanups.size === 0) {
      for (const name of INTERRUPTS) process.off(name, onInterrupt);
    }
  };
}

// When the process under the pid started: null when none runs under it, undefined when that cannot be told.
async function processStartTime(pid: number): Promise<string | null | undefined> {
  if (!processAlive(pid)) {
    return null;
  }
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 22, counted from the state that follows the command name, which can hold spaces and parentheses.
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    } catch {
      return processAlive(pid) ? undefined : null;
    }
  }
  const result = POSIX
    ? await execa('ps', ['-o', 'lstart=', '-p', String(pid)], { reject: false })
    : await execa('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`], {
        reject: false,
        windowsHide: true
      });
  const start = String(result.stdout ?? '').trim();
  if (result.exitCode === 0 && start !== '') {
    return start;
  }
  return processAlive(pid) ? undefined : null;
}

// Whether the dsh web dshenv launched under this pid still runs; a process that later reuses the pid is not it.
export async function dshWebState(pid: number, leaderStart: string): Promise<DshWebState> {
  const start = await processStartTime(pid);
  if (start === undefined) {
    return 'unknown';
  }
  if (start === leaderStart) {
    return 'running';
  }
  // A pid that still names a live process group is not handed out again, so that group is what this dsh web left.
  return start === null && POSIX && groupAlive(pid) ? 'leftover' : 'stopped';
}

// pnpm echoes the script ("$ node ...") before a source checkout's output and adds an ELIFECYCLE line after it.
// A login URL the pattern above does not match (another host, say) must not reach the error either.
function firstErrorLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('$ ') && !line.includes('ELIFECYCLE'))
    ?.replace(/token=[^\s&]*/g, 'token=<redacted>');
}

function spawnDshWeb(profile: string, command: CommandSpec, options: LaunchDshWebOptions) {
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true, mode: 0o700 });
  // execa types a file descriptor only as a literal above the standard ones; a newly opened file never gets 0-2.
  const log = fs.openSync(options.logFile, 'w', 0o600) as 3;
  try {
    // execa runs Windows command shims such as the dsh.cmd npm installs; cleanup: false lets dsh web outlive dshenv.
    // detached gives it its own process group (POSIX) or keeps it off dshenv's console (Windows), so closing the terminal
    // that ran dshenv does not stop it.
    return execa(command.file, [...command.args, '--profile', profile, '--no-open', '--port', String(options.port ?? 0)], {
      cwd: command.cwd,
      env: { ...process.env, DSH_HOME: options.dshHome },
      stdin: 'ignore',
      stdout: log,
      stderr: log,
      detached: true,
      cleanup: false,
      reject: false,
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
  const child = spawnDshWeb(profile, command, options);
  // Nothing else knows about this dsh web until the caller has its pid and URL.
  const dispose = stopOnInterrupt(async () => {
    if (child.pid !== undefined) await stopProcessGroup(child.pid);
  });
  try {
    const { pid, url } = await awaitUrl(profile, child, options);
    const leaderStart = await processStartTime(pid);
    if (typeof leaderStart !== 'string') {
      await stopProcessGroup(pid);
      throw new DshError(`dsh --profile ${profile} started dsh web (pid ${pid}), but dshenv could not tell when it started, so it could not stop it safely later`);
    }
    return { pid, url, leaderStart };
  } finally {
    dispose();
  }
}

async function awaitUrl(profile: string, child: ReturnType<typeof spawnDshWeb>, options: LaunchDshWebOptions): Promise<{ pid: number; url: string }> {
  const timeoutMs = options.timeoutMs ?? DSH_WEB_START_TIMEOUT_MS;
  let exit: string | undefined;
  void child.then((result) => {
    exit = result.exitCode === undefined && result.code ? `failed to start dsh (${result.code})` : `it exited with code ${String(result.exitCode)}`;
  });
  child.nodeChildProcess.unref();

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The cleanup is stopping this dsh web; its exit is not a failure to report, the signal ends dshenv.
    if (interrupting) await new Promise(() => {});
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
  const removeDir = () => fs.rmSync(dir, { recursive: true, force: true });
  let pid: number | undefined;
  // launchDshWeb stops dsh web if interrupted while it starts; this also covers the check and the log directory.
  const dispose = stopOnInterrupt(async () => {
    if (pid !== undefined) await stopProcessGroup(pid);
    removeDir();
  });
  try {
    const launched = await launchDshWeb(profile, { ...options, logFile: path.join(dir, 'dsh-web.log') });
    pid = launched.pid;
    return {
      url: launched.url,
      stop: async () => {
        await stopProcessGroup(launched.pid);
        dispose();
        removeDir();
      }
    };
  } catch (error) {
    dispose();
    removeDir();
    throw error;
  }
}
