import { execa, execaSync } from 'execa';

const FORCE_KILL_AFTER_MS = 5000;
const POLL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Signalling only the direct child would leave the package manager it started still writing the profile.
// Returns the pids it stopped once the whole tree is gone, so dshenv cannot exit before its SIGKILL is sent.
export async function killProcessTree(pid: number): Promise<number[]> {
  if (process.platform === 'win32') {
    await execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false });
    return [pid];
  }
  // Collected before any signal: once a parent exits, its children are reparented and no longer traceable.
  const tree = [pid, ...descendantsOf(pid)];
  let pids = tree;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    signalAll(pids, signal);
    const deadline = Date.now() + FORCE_KILL_AFTER_MS;
    // Dropping each pid as soon as it is gone keeps SIGKILL from reaching a process that later reuses it.
    while ((pids = pids.filter(alive)).length > 0 && Date.now() < deadline) {
      await sleep(POLL_MS);
    }
    if (pids.length === 0) break;
  }
  return tree;
}

// execa's own timeout signals only the direct child; a grandchild (dsh under `pnpm --dir <source> dsh`) keeps the
// output pipes open, and execa waits for them. An abort stops the tree the same way.
export async function awaitWithTreeTimeout<T>(
  subprocess: Promise<T> & { pid?: number },
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ result: T; timedOut: boolean; killed: number[] }> {
  let timedOut = false;
  let killing: Promise<number[]> | undefined;
  const kill = () => {
    if (subprocess.pid !== undefined && !killing) {
      killing = killProcessTree(subprocess.pid);
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  signal?.addEventListener('abort', kill, { once: true });
  if (signal?.aborted) kill();
  try {
    const result = await subprocess;
    return { result, timedOut, killed: (await killing) ?? [] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', kill);
  }
}

function descendantsOf(root: number): number[] {
  const res = execaSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { reject: false });
  const children = new Map<number, number[]>();
  for (const line of String(res.stdout ?? '').split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
  }
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // already exited
    }
  }
}
