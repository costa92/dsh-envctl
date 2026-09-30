import { describe, it, expect } from 'vitest';
import { loadState, serializeState } from '../../src/manifest/files.js';

const record = { package: '@scope/cc', alias: 'cc', sourceType: 'npm', lockedVersion: '1.0.0', adoptedAt: '2026-01-01T00:00:00.000Z', adoptedBy: 'apply-1' };

describe('state resources', () => {
  it('writes the owned resources and reads them back unchanged', () => {
    const state = loadState(JSON.stringify({
      apiVersion: 'dshenv-state/v1',
      lastApplied: '',
      appliedLockHash: '',
      profiles: {},
      resources: { plugin: { web: { '@scope/cc': record } }, skill: { wiki: { digest: 'd1' } } }
    }));
    expect(loadState(serializeState(state))).toEqual(state);
  });

  it('refuses the top-level ownership and skills fields of dshenv 0.4', () => {
    const base = { apiVersion: 'dshenv-state/v1', lastApplied: '', appliedLockHash: '', profiles: {} };
    expect(() => loadState(JSON.stringify({ ...base, ownership: { web: { '@scope/cc': record } } }))).toThrow(/Unrecognized key.*ownership/);
    expect(() => loadState(JSON.stringify({ ...base, skills: { wiki: 'd1' } }))).toThrow(/Unrecognized key.*skills/);
  });
});
