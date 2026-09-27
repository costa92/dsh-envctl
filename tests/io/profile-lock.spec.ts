import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withProfilePackageLock } from '../../src/io/profile-lock.js';

describe('withProfilePackageLock', () => {
  let dir: string;
  let packageJson: string;
  let lockPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-profile-lock-'));
    packageJson = path.join(dir, 'package.json');
    lockPath = `${packageJson}.lock`;
    fs.writeFileSync(packageJson, '{}\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('holds a DSH-compatible lock during the operation and removes it afterwards', async () => {
    let seen: { content: string; mode: number } | null = null;
    const result = await withProfilePackageLock(packageJson, async () => {
      seen = { content: fs.readFileSync(lockPath, 'utf8'), mode: fs.statSync(lockPath).mode & 0o777 };
      return 42;
    });
    expect(result).toBe(42);
    expect(seen).toEqual({ content: `${process.pid}\n`, mode: 0o600 });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('removes its own lock when the operation throws', async () => {
    await expect(
      withProfilePackageLock(packageJson, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('waits for an existing lock and proceeds once it is released', async () => {
    fs.writeFileSync(lockPath, '999999\n', { mode: 0o600 });
    setTimeout(() => fs.rmSync(lockPath, { force: true }), 300);
    const started = Date.now();
    let ranAt = 0;
    await withProfilePackageLock(packageJson, async () => {
      ranAt = Date.now();
    });
    expect(ranAt - started).toBeGreaterThanOrEqual(250);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('times out without touching a lock held by someone else', async () => {
    fs.writeFileSync(lockPath, '999999\n', { mode: 0o600 });
    let ran = false;
    await expect(
      withProfilePackageLock(
        packageJson,
        async () => {
          ran = true;
        },
        { timeoutMs: 200 }
      )
    ).rejects.toThrow(
      `Timed out waiting for the profile lock at ${lockPath}; if no DSH process or dsh plugin command is writing this profile, delete the lock file and retry`
    );
    expect(ran).toBe(false);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('999999\n');
  });
});
