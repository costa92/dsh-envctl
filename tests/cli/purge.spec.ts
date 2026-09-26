import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI purge', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-purge-'));
    await runCli(['init', '--dsh-home', tempHome]);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should refuse purge without --yes', async () => {
    let stderr = '';
    const code = await runCli(['purge', 'agent-teams', '--profile', 'web', '--dsh-home', tempHome], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    expect(code).toBe(3);
    expect(stderr).toMatch(/--yes/);
  });
});
