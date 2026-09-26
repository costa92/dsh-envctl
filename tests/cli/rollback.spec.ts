import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI rollback and gc', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-rb-'));
    await runCli(['init', '--dsh-home', tempHome]);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should refuse rollback without --yes', async () => {
    let stderr = '';
    const code = await runCli(['rollback', '--dsh-home', tempHome], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    expect(code).toBe(3);
    expect(stderr).toMatch(/--yes/);
  });

  it('should refuse gc without --yes', async () => {
    let stderr = '';
    const code = await runCli(['gc', '--dsh-home', tempHome], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    expect(code).toBe(3);
    expect(stderr).toMatch(/--yes/);
  });

  it('should dry-run gc with empty trash', async () => {
    let stdout = '';
    const code = await runCli(['gc', '--dry-run', '--dsh-home', tempHome], {
      stdout: (chunk) => {
        stdout += chunk;
      },
      stderr: () => {}
    });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Would delete 0/);
  });
});
