import { describe, expect, it } from 'vitest';
import type { EnvironmentLock, PluginLockEntry } from '../../src/domain.js';
import { loadLock, serializeLock } from '../../src/manifest/files.js';
import {
  diffLockEntries,
  findLockEntryConflicts,
  findLockEntryDrift,
  lockEntryDigest,
  lockEntryDigests,
  lockEntryId,
  mergeRemoteLock
} from '../../src/remote/lock-entries.js';

const npm = (pkg: string, version: string): PluginLockEntry => ({ package: pkg, source: { type: 'npm', resolvedVersion: version } });
const git = (pkg: string, commit: string): PluginLockEntry => ({
  package: pkg,
  source: { type: 'git', url: `file:///nonexistent/${pkg}.git`, commit }
});
const lockOf = (profiles: Record<string, Record<string, PluginLockEntry>>): EnvironmentLock => ({
  apiVersion: 'dshenv-lock/v1',
  profiles: Object.fromEntries(Object.entries(profiles).map(([profile, plugins]) => [profile, { plugins }]))
});

describe('lock entry ownership', () => {
  it('digests an entry independently of key order and file formatting', () => {
    const compact = loadLock('{"apiVersion":"dshenv-lock/v1","profiles":{"web":{"plugins":{"shared":{"source":{"resolvedVersion":"1.0.0","type":"npm"},"package":"shared-plugin"}}}}}');
    const pretty = loadLock(serializeLock(lockOf({ web: { shared: npm('shared-plugin', '1.0.0') } })));
    expect(lockEntryDigest(compact.profiles.web.plugins.shared)).toBe(lockEntryDigest(pretty.profiles.web.plugins.shared));
    expect(lockEntryDigest(npm('shared-plugin', '1.0.1'))).not.toBe(lockEntryDigest(npm('shared-plugin', '1.0.0')));
    expect(lockEntryDigest(npm('shared-plugin', '1.0.0'))).toMatch(/^[0-9a-f]{64}$/);
    expect(lockEntryId('web', 'shared')).toBe('web/shared');
  });

  it('lists the digests of every entry', () => {
    expect(lockEntryDigests(null)).toEqual({});
    expect(lockEntryDigests(lockOf({ web: { shared: npm('shared-plugin', '1.0.0') }, cli: {} }))).toEqual({
      web: { shared: lockEntryDigest(npm('shared-plugin', '1.0.0')) }
    });
  });

  it('merges: drops the old remote entries, adds the new ones and keeps local entries', () => {
    const local = lockOf({
      web: { shared: npm('shared-plugin', '1.0.0'), tool: git('tool', 'c'.repeat(40)) },
      cli: { old: npm('old-plugin', '1.0.0') }
    });
    const owned = lockEntryDigests(lockOf({ web: { shared: npm('shared-plugin', '1.0.0') }, cli: { old: npm('old-plugin', '1.0.0') } }));
    const target = lockOf({ web: { shared: npm('shared-plugin', '2.0.0'), extra: npm('extra-plugin', '1.0.0') } });

    const merged = mergeRemoteLock(local, owned, target);
    expect(merged).toEqual(lockOf({
      web: { shared: npm('shared-plugin', '2.0.0'), tool: git('tool', 'c'.repeat(40)), extra: npm('extra-plugin', '1.0.0') }
    }));
    // The inputs are never mutated; a failed accept must leave nothing half-merged in memory.
    expect(local.profiles.cli.plugins.old).toEqual(npm('old-plugin', '1.0.0'));
    merged!.profiles.web.plugins.extra.package = 'changed';
    expect(target.profiles.web.plugins.extra.package).toBe('extra-plugin');
  });

  it('creates no lock from nothing and keeps an existing lock file even when it ends up empty', () => {
    const remote = lockOf({ web: { shared: npm('shared-plugin', '1.0.0') } });
    expect(mergeRemoteLock(null, {}, null)).toBeNull();
    expect(mergeRemoteLock(null, {}, remote)).toEqual(remote);
    expect(mergeRemoteLock(remote, lockEntryDigests(remote), null)).toEqual(lockOf({}));
    expect(mergeRemoteLock(lockOf({ empty: {} }), {}, null)).toEqual(lockOf({}));
  });

  it('reports remote entries changed or removed locally, whatever the file formatting', () => {
    const remote = lockOf({ web: { shared: npm('shared-plugin', '1.0.0'), demo: git('demo', 'b'.repeat(40)) } });
    const owned = lockEntryDigests(remote);
    expect(findLockEntryDrift(loadLock(JSON.stringify(remote)), owned)).toEqual([]);
    expect(findLockEntryDrift(lockOf({ web: { demo: git('demo', 'c'.repeat(40)), tool: npm('tool', '1.0.0') } }), owned)).toEqual([
      { entry: 'web/demo', status: 'modified' },
      { entry: 'web/shared', status: 'missing' }
    ]);
    expect(findLockEntryDrift(null, owned)).toEqual([
      { entry: 'web/demo', status: 'missing' },
      { entry: 'web/shared', status: 'missing' }
    ]);
  });

  it('finds local entries a remote entry would replace', () => {
    const local = lockOf({ web: { shared: npm('shared-plugin', '1.0.0'), extra: npm('extra-plugin', '0.9.0') } });
    const owned = lockEntryDigests(lockOf({ web: { shared: npm('shared-plugin', '1.0.0') } }));
    const target = lockEntryDigests(lockOf({ web: { shared: npm('shared-plugin', '2.0.0'), extra: npm('extra-plugin', '1.0.0'), fresh: npm('fresh', '1.0.0') } }));
    expect(findLockEntryConflicts(local, owned, target)).toEqual(['web/extra']);
    expect(findLockEntryConflicts(null, {}, target)).toEqual([]);
  });

  it('classifies entry changes, counting a locally changed entry as modified', () => {
    const before = lockOf({ web: { shared: npm('shared-plugin', '1.0.0'), gone: npm('gone', '1.0.0'), same: npm('same', '1.0.0') } });
    const owned = lockEntryDigests(before);
    const target = lockEntryDigests(lockOf({ web: { shared: npm('shared-plugin', '2.0.0'), same: npm('same', '1.0.0'), added: npm('added', '1.0.0') } }));
    expect(diffLockEntries(before, owned, target)).toEqual({ added: ['web/added'], modified: ['web/shared'], removed: ['web/gone'] });

    const drifted = lockOf({ web: { shared: npm('shared-plugin', '1.0.0'), gone: npm('gone', '1.0.0'), same: npm('same', '9.9.9') } });
    expect(diffLockEntries(drifted, owned, target).modified).toEqual(['web/same', 'web/shared']);
    expect(diffLockEntries(before, owned, owned)).toEqual({ added: [], modified: [], removed: [] });
  });
});
