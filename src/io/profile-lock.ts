import * as fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { DshError } from '../errors.js';

export interface ProfileLockOptions {
  timeoutMs?: number;
}

export const PROFILE_LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_INITIAL_MS = 25;
const LOCK_RETRY_MAX_MS = 1_000;

async function tryCreate(lockPath: string, content: string): Promise<boolean> {
  try {
    const handle = await fs.promises.open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

// Same protocol as DSH's atomic-write `<file>.lock`, so dshenv and DSH never write package.json at once.
// Unlike DSH, an existing lock is never taken over: dshenv only waits for it.
export async function withProfilePackageLock<T>(
  packageJsonPath: string,
  operation: () => Promise<T>,
  options?: ProfileLockOptions
): Promise<T> {
  const lockPath = `${packageJsonPath}.lock`;
  const content = `${process.pid}\n`;
  const deadline = Date.now() + (options?.timeoutMs ?? PROFILE_LOCK_TIMEOUT_MS);
  let wait = LOCK_RETRY_INITIAL_MS;
  while (!(await tryCreate(lockPath, content))) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DshError(
        `Timed out waiting for the profile lock at ${lockPath}; ` +
          'if no DSH process or dsh plugin command is writing this profile, delete the lock file and retry',
        1
      );
    }
    await delay(Math.min(wait, remaining));
    wait = Math.min(wait * 2, LOCK_RETRY_MAX_MS);
  }
  try {
    return await operation();
  } finally {
    await fs.promises.rm(lockPath, { force: true });
  }
}
