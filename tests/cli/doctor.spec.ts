import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../src/cli.js';

const officialHarnessFixture = fileURLToPath(new URL('../fixtures/harness-source', import.meta.url));

function makeHarnessSource(parentDir: string): string {
  const sourceDir = path.join(parentDir, 'harness-source');
  fs.cpSync(officialHarnessFixture, sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'package.json'), JSON.stringify({
    private: true,
    scripts: { dsh: 'node ./dsh.cjs' }
  }));
  fs.writeFileSync(path.join(sourceDir, 'dsh.cjs'),
    'if (process.argv.includes("--version")) console.log("0.1.7-rc.2");\n');
  return sourceDir;
}

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
echo "0.1.70"
exit 0
`
    );
    fs.chmodSync(unsuppDsh, 0o755);

    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = unsuppDsh;

    let stderr = '';
    let stdout = '';
    const io = {
      stdout: (chunk: string) => { stdout += chunk; },
      stderr: (chunk: string) => { stderr += chunk; }
    };

    try {
      const code = await runCli(['doctor', '--dsh-home', tempHome], io);
      expect(code).toBe(4);
      expect(stdout).toBe('');
      expect(stderr).toContain('Unsupported DSH version');
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('should print doctor JSON without environment or credential dumps', async () => {
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = fakeDsh;
    process.env.SECRET_FOR_DOCTOR = 'should-not-appear';

    let stdout = '';
    const io = {
      stdout: (chunk: string) => {
        stdout += chunk;
      },
      stderr: () => {}
    };

    try {
      const code = await runCli(['doctor', '--json', '--dsh-home', tempHome], io);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout) as {
        runtime: {
          version: string;
          discoverySupported: boolean;
          mutationsSupported: boolean;
          capabilities: { packageOperations: { status: string; source: string; reason?: string } };
        };
        paths: { home: string };
      };
      expect(parsed.runtime).toMatchObject({
        version: '0.1.7-rc.2',
        discoverySupported: true,
        mutationsSupported: false,
        capabilities: {
          packageOperations: {
            status: 'disabled',
            source: 'operations-export',
            reason: 'Official operations export was not verified'
          }
        }
      });
      expect(parsed.paths.home).toBe(tempHome);
      expect(stdout).not.toContain('should-not-appear');
      expect(stdout).not.toContain('SECRET_FOR_DOCTOR');
      expect(stdout).not.toContain('Authorization');
      expect(stdout).not.toContain(officialHarnessFixture);
      expect(Object.keys(parsed).sort()).toEqual(['paths', 'runtime']);
    } finally {
      delete process.env.SECRET_FOR_DOCTOR;
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('reports verified official surfaces from an explicit harness source in compatible JSON', async () => {
    const sourceDir = makeHarnessSource(fakeBinDir);
    const oldDshCli = process.env.DSH_CLI;
    delete process.env.DSH_CLI;
    process.env.DOCTOR_AUTHORIZATION = 'Bearer doctor-secret';

    let stdout = '';
    let stderr = '';
    try {
      const code = await runCli(['doctor', '--json', '--dsh-home', tempHome, '--harness-source', sourceDir], {
        stdout: chunk => { stdout += chunk; },
        stderr: chunk => { stderr += chunk; }
      });

      expect(code).toBe(0);
      expect(stderr).toBe('');
      const parsed = JSON.parse(stdout) as { runtime: unknown };
      expect(parsed.runtime).toMatchObject({
        version: '0.1.7-rc.2',
        discoverySupported: true,
        mutationsSupported: false,
        capabilities: {
          packageOperations: { status: 'available', source: 'operations-export' },
          bundleSelection: { status: 'requires-live-service', source: 'live-service' },
          environmentMutation: { status: 'disabled', source: 'dshenv' }
        }
      });
      expect(stdout).not.toContain('Bearer doctor-secret');
      expect(stdout).not.toContain('DOCTOR_AUTHORIZATION');
      expect(stdout).not.toContain('Authorization');
      expect(stdout).not.toContain(officialHarnessFixture);
    } finally {
      delete process.env.DOCTOR_AUTHORIZATION;
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });

  it('does not expose DSH_CLI authentication arguments in doctor output', async () => {
    const authDsh = path.join(fakeBinDir, 'auth-dsh.sh');
    fs.writeFileSync(authDsh, '#!/bin/sh\necho "0.1.7-rc.2"\n');
    fs.chmodSync(authDsh, 0o755);
    const oldDshCli = process.env.DSH_CLI;
    process.env.DSH_CLI = JSON.stringify([authDsh, '--Authorization', 'Bearer doctor-secret']);

    try {
      for (const args of [
        ['doctor', '--json', '--dsh-home', tempHome],
        ['doctor', '--dsh-home', tempHome]
      ]) {
        let stdout = '';
        const code = await runCli(args, { stdout: chunk => { stdout += chunk; } });
        expect(code).toBe(0);
        expect(stdout).not.toContain('Authorization');
        expect(stdout).not.toContain('Bearer doctor-secret');
      }
    } finally {
      if (oldDshCli) process.env.DSH_CLI = oldDshCli;
      else delete process.env.DSH_CLI;
    }
  });
});
