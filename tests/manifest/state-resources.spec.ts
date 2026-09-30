import { describe, it, expect } from 'vitest';
import { loadState, serializeState } from '../../src/manifest/files.js';

const record = { package: '@scope/cc', alias: 'cc', sourceType: 'npm', lockedVersion: '1.0.0', adoptedAt: '2026-01-01T00:00:00.000Z', adoptedBy: 'apply-1' };

describe('state resources', () => {
  it('reads a v1 state into the resources it owns', () => {
    const state = loadState(JSON.stringify({
      apiVersion: 'dshenv-state/v1',
      lastApplied: '2026-01-01T00:00:00.000Z',
      appliedLockHash: 'h',
      profiles: {},
      ownership: { web: { '@scope/cc': record } },
      appliedOverlay: 'local',
      skills: { wiki: 'd1' }
    }));

    expect(state).toEqual({
      apiVersion: 'dshenv-state/v2',
      lastApplied: '2026-01-01T00:00:00.000Z',
      appliedLockHash: 'h',
      profiles: {},
      appliedOverlay: 'local',
      resources: { plugin: { web: { '@scope/cc': record } }, skill: { wiki: { digest: 'd1' } } }
    });
  });

  it('leaves resources out of a v1 state that owns nothing', () => {
    const state = loadState(JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: '', appliedLockHash: '', profiles: {}, ownership: {} }));
    expect(state).toEqual({ apiVersion: 'dshenv-state/v2', lastApplied: '', appliedLockHash: '', profiles: {} });
  });

  it('writes v2 and reads it back unchanged', () => {
    const state = loadState(JSON.stringify({
      apiVersion: 'dshenv-state/v2',
      lastApplied: '',
      appliedLockHash: '',
      profiles: {},
      resources: { plugin: { web: { '@scope/cc': record } }, skill: { wiki: { digest: 'd1' } } }
    }));
    const written = serializeState(state);
    expect(JSON.parse(written)).not.toHaveProperty('ownership');
    expect(loadState(written)).toEqual(state);
  });

  it('refuses the v1 fields in a v2 state and an unknown version', () => {
    expect(() => loadState(JSON.stringify({ apiVersion: 'dshenv-state/v2', lastApplied: '', appliedLockHash: '', profiles: {}, skills: {} }))).toThrow(/skills/);
    expect(() => loadState(JSON.stringify({ apiVersion: 'dshenv-state/v3', lastApplied: '', appliedLockHash: '', profiles: {} }))).toThrow(/apiVersion/);
  });
});
