import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { checkNpmVersion } from '../../src/source/npm-registry.js';

// Stands in for npm on PATH; POSIX only, as Windows would need a .cmd shim.
describe.skipIf(process.platform === 'win32')('checkNpmVersion', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    savedPath = process.env.PATH;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-npm-registry-'));
    fs.writeFileSync(
      path.join(dir, 'npm'),
      // Like npm waiting on a registry it cannot reach, with a child of its own holding the output open.
      `#!/bin/sh\nsleep 30 &\necho $! > '${path.join(dir, 'child.pid')}'\nwait\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${dir}${path.delimiter}${savedPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives up on an unreachable registry quickly and stops what npm started', async () => {
    const started = Date.now();
    const check = await checkNpmVersion('@acme/plugin', '1.0.0', { timeoutMs: 300 });
    expect(check).toEqual({ status: 'unknown', reason: 'npm view timed out', reachable: false });
    expect(Date.now() - started).toBeLessThan(4_000);
    const child = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8'));
    expect(() => process.kill(child, 0)).toThrow();
  });
});
