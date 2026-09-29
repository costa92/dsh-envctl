import { execa, execaSync } from 'execa';

const FORCE_KILL_AFTER_MS = 5000;
const POLL_MS = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Signalling only the direct child would leave the package manager it started still writing the profile.
// Returns once the whole tree is gone, so dshenv cannot exit before its SIGKILL is sent.
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await execa('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false });
    return;
  }
  // Collected before any signal: once a parent exits, its children are reparented and no longer traceable.
  let pids = [pid, ...descendantsOf(pid)];
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    signalAll(pids, signal);
    const deadline = Date.now() + FORCE_KILL_AFTER_MS;
    // Dropping each pid as soon as it is gone keeps SIGKILL from reaching a process that later reuses it.
    while ((pids = pids.filter(alive)).length > 0 && Date.now() < deadline) {
      await sleep(POLL_MS);
    }
    if (pids.length === 0) return;
  }
}

// execa's own timeout signals only the direct child; a grandchild (dsh under `pnpm --dir <source> dsh`) keeps the
// output pipes open, and execa waits for them.
export async function awaitWithTreeTimeout<T>(
  subprocess: Promise<T> & { pid?: number },
  timeoutMs: number
): Promise<{ result: T; timedOut: boolean }> {
  let timedOut = false;
  let killing: Promise<void> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    if (subprocess.pid !== undefined) {
      killing = killProcessTree(subprocess.pid);
    }
  }, timeoutMs);
  try {
    const result = await subprocess;
    await killing;
    return { result, timedOut };
  } finally {
    clearTimeout(timer);
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
