import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { EnvironmentPaths } from '../environment/paths.js';
import { DshError } from '../errors.js';

export interface LockHandle {
  lockPath: string;
  release: () => Promise<void>;
}

const LOCK_RETRY_MS = 100;
const LOCK_WRITE_GRACE_MS = 5000;

async function tryCreateLock(lockFilePath: string, lockContent: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(lockFilePath, 'wx', 0o600);
    await handle.writeFile(lockContent);
    await handle.close();
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
  }

  // Check if stale lock
  let isStale = false;
  try {
    const stat = await fs.promises.stat(lockFilePath);
    const raw = await fs.promises.readFile(lockFilePath, 'utf8');
    let info: { pid?: number; hostname?: string } | null = null;
    try {
      info = JSON.parse(raw);
    } catch {
      // The holder creates the file before writing it; only an old unreadable lock is abandoned.
      isStale = Date.now() - stat.mtimeMs > LOCK_WRITE_GRACE_MS;
    }
    if (info?.pid && info.hostname === os.hostname()) {
      try {
        // Check if process is still alive
        process.kill(info.pid, 0);
      } catch {
        isStale = true;
      }
    }
  } catch {
    // The lock vanished while being inspected; retry.
    return false;
  }

  if (!isStale) {
    return false;
  }
  try {
    await fs.promises.unlink(lockFilePath);
    const handle = await fs.promises.open(lockFilePath, 'wx', 0o600);
    await handle.writeFile(lockContent);
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

export async function acquireEnvironmentLock(
  paths: EnvironmentPaths,
  timeoutMs = 5000
): Promise<LockHandle> {
  const lockDir = paths.managerDir;
  await fs.promises.mkdir(lockDir, { recursive: true });
  const lockFilePath = path.join(lockDir, 'dshenv.lock');

  const lockContent = JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString()
  });

  const deadline = Date.now() + timeoutMs;
  while (!(await tryCreateLock(lockFilePath, lockContent))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DshError(`Environment lock is already held at ${lockFilePath}`, 1);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(LOCK_RETRY_MS, remaining)));
  }

  return {
    lockPath: lockFilePath,
    release: async () => {
      try {
        await fs.promises.unlink(lockFilePath);
      } catch {
        // ignore
      }
    }
  };
}
