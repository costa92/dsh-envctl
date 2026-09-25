import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { EnvironmentPaths } from '../environment/paths.js';
import { DshError } from '../errors.js';

export interface LockHandle {
  lockPath: string;
  release: () => Promise<void>;
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

  try {
    const handle = await fs.promises.open(lockFilePath, 'wx', 0o600);
    await handle.writeFile(lockContent);
    await handle.close();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Check if stale lock
      let isStale = false;
      try {
        const raw = await fs.promises.readFile(lockFilePath, 'utf8');
        const info = JSON.parse(raw);
        if (info.pid && info.hostname === os.hostname()) {
          try {
            // Check if process is still alive
            process.kill(info.pid, 0);
          } catch {
            isStale = true;
          }
        }
      } catch {
        isStale = true;
      }

      if (isStale) {
        try {
          await fs.promises.unlink(lockFilePath);
          const handle = await fs.promises.open(lockFilePath, 'wx', 0o600);
          await handle.writeFile(lockContent);
          await handle.close();
        } catch {
          throw new DshError(`Environment lock is already held at ${lockFilePath}`, 1);
        }
      } else {
        throw new DshError(`Environment lock is already held at ${lockFilePath}`, 1);
      }
    } else {
      throw err;
    }
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
