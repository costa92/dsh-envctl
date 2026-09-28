import { describe, it, expect } from 'vitest';
import { loadLock } from '../../src/manifest/files.js';

const lockWithCommit = (commit: string) => JSON.stringify({
  apiVersion: 'dshenv-lock/v1',
  profiles: { web: { plugins: { demo: { package: 'demo-plugin', source: { type: 'git', url: 'https://example.com/demo.git', commit } } } } }
});

describe('git commits in the lock', () => {
  it.each(['main', 'v1.0.0', 'HEAD', 'abc12', 'g1234567'])('rejects %j, which does not name a fixed commit', (commit) => {
    expect(() => loadLock(lockWithCommit(commit))).toThrow(/commit/);
  });

  it.each(['1a2b3c4', 'ABCDEF0123456789abcdef0123456789abcdef01'])('accepts %j', (commit) => {
    expect(loadLock(lockWithCommit(commit)).profiles.web.plugins.demo.source).toMatchObject({ commit });
  });
});
