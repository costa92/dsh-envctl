import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { gcEnvironment } from '../../src/gc/gc.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

describe('gcEnvironment', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-gc-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should delete expired trash entries and keep recent ones', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.trashDir, { recursive: true });
    const oldDir = path.join(paths.trashDir, 'old-item');
    const newDir = path.join(paths.trashDir, 'new-item');
    fs.mkdirSync(oldDir);
    fs.mkdirSync(newDir);
    fs.writeFileSync(path.join(oldDir, 'note.txt'), 'old');
    fs.writeFileSync(path.join(newDir, 'note.txt'), 'new');
    const nineDaysAgo = Date.now() - 9 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldDir, nineDaysAgo / 1000, nineDaysAgo / 1000);

    const result = await gcEnvironment(paths, { olderThanDays: 7 });
    expect(result.deleted.some((item) => item.endsWith('old-item'))).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(true);
  });

  it('should not delete trash on dry-run', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    fs.mkdirSync(paths.trashDir, { recursive: true });
    const oldDir = path.join(paths.trashDir, 'old-item');
    fs.mkdirSync(oldDir);
    const nineDaysAgo = Date.now() - 9 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldDir, nineDaysAgo / 1000, nineDaysAgo / 1000);

    const result = await gcEnvironment(paths, { olderThanDays: 7, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(true);
  });
});
