import { execa } from 'execa';
import type { CommandSpec } from './command.js';
import { CapabilityError, DshError } from '../errors.js';

export interface StartedDshWeb {
  url: string;
  stop(): Promise<void>;
}

export interface StartDshWebOptions {
  command: CommandSpec | null;
  dshHome: string;
  timeoutMs?: number;
}

export const DSH_WEB_START_TIMEOUT_MS = 60_000;
const STOP_GRACE_MS = 5_000;
const URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/;

// Starts `dsh --profile <profile>` as dsh web on a free port. The URL carries the login token, so it is only
// returned, never printed; errors quote DSH's own first stderr line, never the command line (DSH_CLI can hold credentials).
export async function startDshWeb(profile: string, options: StartDshWebOptions): Promise<StartedDshWeb> {
  const { command } = options;
  if (!command) {
    throw new CapabilityError('DSH CLI was not found; configure DSH_CLI or --harness-source');
  }
  const timeoutMs = options.timeoutMs ?? DSH_WEB_START_TIMEOUT_MS;
  // Its own process group, so stopping it also stops what it spawned (MCP servers, pnpm's node).
  const detached = process.platform !== 'win32';
  const child = execa(command.file, [...command.args, '--profile', profile, '--no-open', '--port', '0'], {
    cwd: command.cwd,
    env: { ...process.env, DSH_HOME: options.dshHome },
    shell: false,
    reject: false,
    stdin: 'ignore',
    detached,
    cleanup: true
  });
  const exited = child.then((result) => result.exitCode);
  let childDone = false;
  void exited.then(() => {
    childDone = true;
  });

  const signal = (name: NodeJS.Signals): void => {
    try {
      if (detached && child.pid !== undefined) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // Already gone.
    }
  };
  // Done when the whole group is gone: what DSH started (an MCP server, say) can outlive DSH itself for a moment.
  const running = async (): Promise<boolean> => {
    if (!detached || child.pid === undefined) {
      return !childDone;
    }
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      await exited;
      return false;
    }
  };
  const settled = async (deadline: number): Promise<boolean> => {
    while (await running()) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
  };
  const stop = async (): Promise<void> => {
    signal('SIGTERM');
    if (!(await settled(Date.now() + STOP_GRACE_MS))) {
      signal('SIGKILL');
      await settled(Date.now() + STOP_GRACE_MS);
    }
  };

  let stdout = '';
  let stderr = '';
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DshError(`dsh --profile ${profile} did not print a dsh web URL within ${timeoutMs} ms`));
    }, timeoutMs);
    const scan = (): void => {
      const match = URL_PATTERN.exec(stdout) ?? URL_PATTERN.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      scan();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      scan();
    });
    void exited.then((exitCode) => {
      clearTimeout(timer);
      // pnpm echoes the script ("$ node ...") before a source checkout's output and adds an ELIFECYCLE line after it.
      const line = stderr
        .split(/\r?\n/)
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate.length > 0 && !candidate.startsWith('$ ') && !candidate.includes('ELIFECYCLE'));
      reject(new DshError(`dsh --profile ${profile} did not start dsh web: ${line ?? `it exited with code ${String(exitCode)}`}`));
    });
  }).catch(async (error: unknown) => {
    await stop();
    throw error;
  });

  return { url, stop };
}
