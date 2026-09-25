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
});
