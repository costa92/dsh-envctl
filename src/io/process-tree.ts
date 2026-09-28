import { execaSync } from 'execa';

const FORCE_KILL_AFTER_MS = 5000;

// Signalling only the direct child would leave the package manager it started still writing the profile.
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    execaSync('taskkill', ['/pid', String(pid), '/T', '/F'], { reject: false });
    return;
  }
  // Collected before any signal: once a parent exits, its children are reparented and no longer traceable.
  const pids = [pid, ...descendantsOf(pid)];
  signalAll(pids, 'SIGTERM');
  setTimeout(() => signalAll(pids, 'SIGKILL'), FORCE_KILL_AFTER_MS).unref();
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

function signalAll(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // already exited
    }
  }
}
