import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI gc', () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-gc-'));
    await runCli(['init', '--dsh-home', tempHome]);
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // NaN compares false against every age, which would read as "everything is expired".
  it('refuses a --older-than that is not a number and keeps the trash', async () => {
    const item = path.join(tempHome, 'envctl', 'trash', 'recent-item');
    fs.mkdirSync(item, { recursive: true });
    let stderr = '';
    const code = await runCli(['gc', '--older-than', 'abc', '--yes', '--dsh-home', tempHome], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    expect(code).toBe(3);
    expect(stderr).toContain('Invalid --older-than value: abc');
    expect(fs.existsSync(item)).toBe(true);
  });
});
