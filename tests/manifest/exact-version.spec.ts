import { describe, it, expect } from 'vitest';
import { loadManifest, parseOverlay } from '../../src/manifest/files.js';

const manifestWith = (version: string) => `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      demo:
        package: demo-plugin
        source: { type: npm, version: "${version}" }
`;

describe('exact npm versions', () => {
  it.each(['*', '^1.0.0', '~1.2.0', 'latest', '1.x', '>=1.0.0'])('rejects %j in the manifest', (version) => {
    expect(() => loadManifest(manifestWith(version))).toThrow(/npm version must be an exact version such as 1\.2\.3/);
  });

  it.each(['1.2.3', '0.1.7-rc.2', '1.0.0+build.5'])('accepts %j in the manifest', (version) => {
    expect(loadManifest(manifestWith(version)).profiles.web.plugins.demo.source).toEqual({ type: 'npm', version });
  });

  it('rejects a range in an overlay source override', () => {
    const overlay = `apiVersion: dshenv-overlay/v1
profiles:
  web:
    plugins:
      demo:
        source: { type: npm, version: "^2.0.0" }
`;
    expect(() => parseOverlay(overlay, '/x/laptop.yaml')).toThrow(/npm version must be an exact version/);
  });
});
