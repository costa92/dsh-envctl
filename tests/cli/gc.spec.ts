import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runCli } from '../../src/cli.js';

describe('CLI gc', () => {
  let tempHome: string;
  let trashItem: string;

  const run = async (args: string[]) => {
    let stderr = '';
    const code = await runCli([...args, '--dsh-home', tempHome], {
      stdout: () => {},
      stderr: (chunk) => {
        stderr += chunk;
      }
    });
    return { code, stderr };
  };

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-cli-gc-'));
    trashItem = path.join(tempHome, 'envctl', 'trash', 'apply-1');
    fs.mkdirSync(trashItem, { recursive: true });
    fs.writeFileSync(path.join(trashItem, 'note.txt'), 'keep');
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('refuses an --older-than that is not a number of days, rather than deleting all trash', async () => {
    for (const value of ['abc', '', ' ', '-1', '1e3', '0x10']) {
      const out = await run(['gc', '--older-than', value, '--yes']);
      expect(out.code, value).toBe(3);
      expect(out.stderr).toMatch(/Invalid --older-than value/);
    }
    expect(fs.existsSync(path.join(trashItem, 'note.txt'))).toBe(true);
  });

  it('accepts whole and fractional days', async () => {
    expect((await run(['gc', '--older-than', '7', '--yes'])).code).toBe(0);
    expect((await run(['gc', '--older-than', '0.5', '--dry-run'])).code).toBe(0);
    expect(fs.existsSync(path.join(trashItem, 'note.txt'))).toBe(true);
  });
});
