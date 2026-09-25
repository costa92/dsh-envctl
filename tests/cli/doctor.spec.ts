import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI doctor', () => {
  let tempHome: string;
  let fakeBinDir: string;
  let fakeDsh: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-home-'));
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-doc-bin-'));
    fakeDsh = path.join(fakeBinDir, 'fake-dsh.sh');

    fs.writeFileSync(
      fakeDsh,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "0.1.7-rc.2"
  exit 0
fi
exit 0
`
    );
    fs.chmodSync(fakeDsh, 0o755);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it('should pass doctor with supported DSH runtime', async () => {
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = fakeDsh;

    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: () => {}
    };

    try {
      const code = await runCli(['doctor', '--dsh-home', tempHome], io);
      expect(code).toBe(0);
      expect(stdout).toContain('0.1.7-rc.2');
      expect(stdout).toContain('DSH Environment Doctor');
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('should exit with code 4 when DSH version is unsupported', async () => {
    const unsuppDsh = path.join(fakeBinDir, 'unsupported-dsh.sh');
    fs.writeFileSync(
      unsuppDsh,
      `#!/bin/sh
echo "0.0.1"
exit 0
`
    );
    fs.chmodSync(unsuppDsh, 0o755);

    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = unsuppDsh;

    let stderr = '';
    const io = {
      stdout: () => {},
      stderr: (chunk: string) => { stderr += chunk; }
    };

    try {
      const code = await runCli(['doctor', '--dsh-home', tempHome], io);
      expect(code).toBe(4);
      expect(stderr).toContain('Unsupported DSH version');
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });
});
