import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const lockHook = vi.hoisted(() => ({ beforeAcquire: undefined as (() => void) | undefined }));

vi.mock('../../src/io/lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/io/lock.js')>();
  return {
    ...actual,
    acquireEnvironmentLock: async (...args: Parameters<typeof actual.acquireEnvironmentLock>) => {
      lockHook.beforeAcquire?.();
      return actual.acquireEnvironmentLock(...args);
    }
  };
});

const { applyEnvironment } = await import('../../src/apply/apply.js');
const { resolveEnvironmentPaths } = await import('../../src/environment/paths.js');

describe('applyEnvironment locking', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-apply-lock-test-'));
    fs.mkdirSync(path.join(tempHome, 'envctl'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, 'envctl', 'manifest.yaml'),
      `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      demo:
        package: demo-plugin
        source:
          type: npm
          version: "1.0.0"
`
    );
  });

  afterEach(() => {
    lockHook.beforeAcquire = undefined;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('should plan from the files as they are once the lock is held', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    // A concurrent rollback finishes and releases the lock just before apply acquires it.
    lockHook.beforeAcquire = () => {
      fs.writeFileSync(paths.manifestFile, 'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins: {}\n');
    };
    const executor = vi.fn(async () => ({ success: true }));

    const result = await applyEnvironment(paths, { executor });

    expect(executor).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(result.plan.hasChanges).toBe(false);
  });

  it('should not take the lock for a dry run', async () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: tempHome });
    lockHook.beforeAcquire = () => {
      throw new Error('dry run must not lock');
    };

    const result = await applyEnvironment(paths, { dryRun: true });
    expect(result.plan.operations.map((op) => op.kind)).toEqual(['install']);
  });
});
