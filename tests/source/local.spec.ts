import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  inspectLocalSource,
  calculateSourceDigest
} from '../../src/source/local.js';
import { ValidationError } from '../../src/errors.js';

describe('Local Source Lifecycle and Digest', () => {
  let tempDir: string;
  let pkgDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-local-test-'));
    pkgDir = path.join(tempDir, 'my-local-pkg');
    fs.mkdirSync(pkgDir, { recursive: true });

    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'my-local-pkg',
        version: '1.0.0',
        dsh: { bundle: 'dist/index.js' }
      })
    );
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'console.log("hello");');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should inspect valid local package source', async () => {
    const info = await inspectLocalSource(pkgDir);
    expect(info.isValid).toBe(true);
    expect(info.name).toBe('my-local-pkg');
    expect(info.version).toBe('1.0.0');
    expect(info.digest).toBeTruthy();
  });

  it('should calculate stable digest ignoring node_modules and .git', async () => {
    const digest1 = await calculateSourceDigest(pkgDir);

    // Add node_modules file - should not alter source digest
    const nmDir = path.join(pkgDir, 'node_modules', 'foo');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.writeFileSync(path.join(nmDir, 'index.js'), 'ignored');

    const digest2 = await calculateSourceDigest(pkgDir);
    expect(digest1).toBe(digest2);

    // Modify source file - should change digest
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'console.log("modified");');
    const digest3 = await calculateSourceDigest(pkgDir);
    expect(digest3).not.toBe(digest1);
  });

  it('should reject non-absolute path', async () => {
    await expect(inspectLocalSource('relative/path')).rejects.toThrow(ValidationError);
  });
});
