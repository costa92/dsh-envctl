import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeAtomic } from '../../src/io/atomic-file.js';
import { acquireFileLock } from '../../src/io/lock.js';

const RUN_MS = 2000;

// Another dshenv command reading the file the whole time, as one reading the manifest before it takes the lock does.
function keepReading(file: string): ChildProcess {
  return spawn(
    process.execPath,
    ['-e', `const fs = require('fs'); for (;;) { try { fs.readFileSync(${JSON.stringify(file)}); } catch {} }`],
    { stdio: 'ignore' }
  );
}

// On Windows these fail with EPERM while the other process has the file open.
describe('file writes while another process reads the file', () => {
  let dir: string;
  let reader: ChildProcess | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-readers-'));
  });

  afterEach(() => {
    reader?.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replaces the file every time', async () => {
    const file = path.join(dir, 'manifest.yaml');
    fs.writeFileSync(file, '0');
    reader = keepReading(file);
    const end = Date.now() + RUN_MS;
    let written = 0;
    while (Date.now() < end) {
      await writeAtomic(file, String(++written), 'overwrite');
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(String(written));
  }, 30_000);

  it('takes and releases the lock every time', async () => {
    const lockFile = path.join(dir, 'dshenv.lock');
    reader = keepReading(lockFile);
    const end = Date.now() + RUN_MS;
    const holder = async () => {
      while (Date.now() < end) {
        const handle = await acquireFileLock(lockFile, 'Environment lock', 5000);
        await handle.release();
      }
    };
    await Promise.all([holder(), holder()]);
    expect(fs.existsSync(lockFile)).toBe(false);
  }, 30_000);
});
