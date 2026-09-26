import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { writeAtomic } from '../../src/io/atomic-file.js';

describe('writeAtomic', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-atomic-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should write file atomically in create mode', async () => {
    const targetFile = path.join(tempDir, 'sub', 'test.txt');
    await writeAtomic(targetFile, 'hello world', 'create');

    expect(fs.readFileSync(targetFile, 'utf8')).toBe('hello world');
    const stat = fs.statSync(targetFile);
    // mode includes permissions
    expect(stat.isFile()).toBe(true);
  });

  it('should refuse to overwrite existing file in create mode and preserve original bytes', async () => {
    const targetFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(targetFile, 'original content', 'utf8');

    await expect(writeAtomic(targetFile, 'new content', 'create')).rejects.toThrow();

    // Verify original content is intact
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('original content');

    // Verify no stray temp files left behind
    const files = fs.readdirSync(tempDir);
    expect(files).toEqual(['test.txt']);
  });

  it('should overwrite existing file in overwrite mode', async () => {
    const targetFile = path.join(tempDir, 'test.txt');
    fs.writeFileSync(targetFile, 'original content', 'utf8');

    await writeAtomic(targetFile, 'new content', 'overwrite');

    expect(fs.readFileSync(targetFile, 'utf8')).toBe('new content');
  });

  it('writes through a symlink to its target, keeping the link', async () => {
    const realFile = path.join(tempDir, 'dotfiles', 'package.json');
    fs.mkdirSync(path.dirname(realFile));
    fs.writeFileSync(realFile, 'old');
    const link = path.join(tempDir, 'package.json');
    fs.symlinkSync(realFile, link);

    await writeAtomic(link, 'new', 'overwrite');

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(realFile, 'utf8')).toBe('new');
  });

  it('keeps the permissions of the file it overwrites', async () => {
    const targetFile = path.join(tempDir, 'shared.yml');
    fs.writeFileSync(targetFile, 'old');
    fs.chmodSync(targetFile, 0o644);

    await writeAtomic(targetFile, 'new', 'overwrite');

    expect(fs.statSync(targetFile).mode & 0o777).toBe(0o644);
  });

  it('still creates new files private to the owner', async () => {
    const targetFile = path.join(tempDir, 'fresh.json');
    await writeAtomic(targetFile, '{}', 'overwrite');
    expect(fs.statSync(targetFile).mode & 0o777).toBe(0o600);
  });
});
