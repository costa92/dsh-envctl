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

async function createLockFile(lockFilePath: string, lockContent: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(lockFilePath, 'wx', 0o600);
    await handle.writeFile(lockContent);
    await handle.close();
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    return false;
  }
}

async function isStaleLock(lockFilePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(lockFilePath);
    const raw = await fs.promises.readFile(lockFilePath, 'utf8');
    let info: { pid?: number; hostname?: string };
    try {
      info = JSON.parse(raw);
    } catch {
      // The holder creates the file before writing it; only an old unreadable lock is abandoned.
      return Date.now() - stat.mtimeMs > LOCK_WRITE_GRACE_MS;
    }
    if (info?.pid && info.hostname === os.hostname()) {
      try {
        // Check if process is still alive
        process.kill(info.pid, 0);
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    // The lock vanished while being inspected; retry.
    return false;
  }
}

// Deleting someone else's lock is serialized by an atomic mkdir guard, so two waiters can never both
// judge the same stale lock and then remove the lock the other one just created.
async function reclaimStaleLock(lockFilePath: string, guardPath: string): Promise<void> {
  try {
    await fs.promises.mkdir(guardPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return;
    }
    throw err;
  }
  try {
    if (await isStaleLock(lockFilePath)) {
      await fs.promises.rm(lockFilePath, { force: true });
    }
  } finally {
    await fs.promises.rmdir(guardPath);
  }
}

async function tryCreateLock(lockFilePath: string, guardPath: string, lockContent: string): Promise<boolean> {
  if (await createLockFile(lockFilePath, lockContent)) {
    return true;
  }
  await reclaimStaleLock(lockFilePath, guardPath);
  return createLockFile(lockFilePath, lockContent);
}

async function staleGuardHint(guardPath: string): Promise<string> {
  try {
    const stat = await fs.promises.stat(guardPath);
    if (Date.now() - stat.mtimeMs > LOCK_WRITE_GRACE_MS) {
      return `; a stale reclaim marker remains at ${guardPath}, remove it once no dshenv process is running`;
    }
  } catch {
    // no guard
  }
  return '';
}

export async function acquireEnvironmentLock(
  paths: EnvironmentPaths,
  timeoutMs = 5000
): Promise<LockHandle> {
  const lockDir = paths.managerDir;
  await fs.promises.mkdir(lockDir, { recursive: true });
  const lockFilePath = path.join(lockDir, 'dshenv.lock');
  const guardPath = `${lockFilePath}.reclaim`;

  const lockContent = JSON.stringify({
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString()
  });

  const deadline = Date.now() + timeoutMs;
  while (!(await tryCreateLock(lockFilePath, guardPath, lockContent))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DshError(`Environment lock is already held at ${lockFilePath}${await staleGuardHint(guardPath)}`, 1);
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

export async function withEnvironmentLock<T>(paths: EnvironmentPaths, fn: () => Promise<T>): Promise<T> {
  const handle = await acquireEnvironmentLock(paths);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
