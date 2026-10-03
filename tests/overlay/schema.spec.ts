import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { parseOverlay, serializeOverlay, loadState } from '../../src/manifest/files.js';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

const VALID = `apiVersion: dshenv-overlay/v1
environment:
  harness:
    sourceDir: /srv/dsh/deepseek-harness
profiles:
  web:
    plugins:
      agent-teams:
        enabled: false
        patches:
          - id: agent-teams
            config: { taskPlanning: solo }
      heavy-indexer:
        remove: true
      laptop-only:
        package: "@me/laptop-tool"
        source: { type: npm, version: "1.2.0" }
`;

describe('overlay schema', () => {
  it('parses a valid overlay', () => {
    const overlay = parseOverlay(VALID, '/x/laptop.yaml');
    expect(overlay.profiles?.web.plugins?.['heavy-indexer']).toEqual({ remove: true });
    expect(overlay.profiles?.web.plugins?.['agent-teams'].enabled).toBe(false);
    expect(overlay.profiles?.web.plugins?.['agent-teams']).not.toHaveProperty('package');
  });

  it.each(['constructor', 'prototype', '@profile', 'has space'])('rejects %j as an overlay plugin alias', (alias) => {
    const content = `apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      "${alias}": { enabled: false }\n`;
    expect(() => parseOverlay(content, '/x/a.yaml')).toThrow(/Invalid overlay schema/);
  });

  it('rejects unknown fields', () => {
    expect(() => parseOverlay('apiVersion: dshenv-overlay/v1\nextra: 1\n', '/x/a.yaml')).toThrow(
      /Invalid overlay schema in \/x\/a\.yaml/
    );
  });

  it('rejects remove combined with other fields', () => {
    const content = `apiVersion: dshenv-overlay/v1
profiles:
  web:
    plugins:
      a:
        remove: true
        enabled: false
`;
    expect(() => parseOverlay(content, '/x/a.yaml')).toThrow(/remove: true cannot be combined/);
  });

  it('round-trips through serializeOverlay', () => {
    const overlay = parseOverlay(VALID, '/x/laptop.yaml');
    expect(parseOverlay(serializeOverlay(overlay), '/x/laptop.yaml')).toEqual(overlay);
  });

  it('exposes overlay paths and accepts appliedOverlay in state', () => {
    const paths = resolveEnvironmentPaths({ cliDshHome: '/tmp/h' });
    expect(paths.overlaysDir).toBe(path.join('/tmp/h', 'envctl', 'overlays'));
    expect(paths.overlaySelectionFile).toBe(path.join('/tmp/h', 'envctl', 'overlay-selection.json'));
    const state = loadState(
      JSON.stringify({ apiVersion: 'dshenv-state/v1', lastApplied: 'x', appliedLockHash: '', profiles: {}, appliedOverlay: 'laptop' })
    );
    expect(state.appliedOverlay).toBe('laptop');
  });
});
