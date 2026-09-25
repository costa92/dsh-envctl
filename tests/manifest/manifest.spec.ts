import { describe, it, expect } from 'vitest';
import {
  loadManifest,
  serializeManifest,
  ManifestSchema,
  CaptureDocumentSchema
} from '../../src/manifest/index.js';
import { ValidationError } from '../../src/errors.js';

describe('Manifest schema and loader', () => {
  it('should parse valid manifest', () => {
    const yamlStr = `
apiVersion: dshenv/v1
environment:
  sourceRoot: /Users/costalong/code/dsh/plugins
  harness:
    sourceDir: /Users/costalong/code/dsh/deepseek-harness
profiles:
  web:
    plugins:
      agent-teams:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
        patches:
          - id: agent-teams
            config:
              taskPlanning: captain
`;
    const manifest = loadManifest(yamlStr);
    expect(manifest.apiVersion).toBe('dshenv/v1');
    expect(manifest.profiles.web.plugins['agent-teams'].package).toBe('@nanmicoder/dsh-agent-teams');
  });

  it('should reject manifest with wrong apiVersion', () => {
    const yamlStr = `
apiVersion: dshenv/v2
profiles: {}
`;
    expect(() => loadManifest(yamlStr)).toThrow(ValidationError);
  });

  it('should reject unknown fields (strict schema)', () => {
    const yamlStr = `
apiVersion: dshenv/v1
unknownField: 123
profiles: {}
`;
    expect(() => loadManifest(yamlStr)).toThrow(ValidationError);
  });

  it('should reject non-absolute local path', () => {
    const yamlStr = `
apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      local-plug:
        package: "local-plug"
        enabled: true
        source:
          type: local-link
          path: "./relative/path"
`;
    expect(() => loadManifest(yamlStr)).toThrow(ValidationError);
  });

  it('should reject duplicate package names under the same profile', () => {
    const yamlStr = `
apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      alias1:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: true
        source:
          type: npm
          version: "0.1.21"
      alias2:
        package: "@nanmicoder/dsh-agent-teams"
        enabled: false
        source:
          type: npm
          version: "0.1.22"
`;
    expect(() => loadManifest(yamlStr)).toThrow(/duplicate package/i);
  });

  it('should serialize manifest deterministically with single trailing newline', () => {
    const manifest = {
      apiVersion: 'dshenv/v1' as const,
      profiles: {
        web: {
          plugins: {
            'agent-teams': {
              package: '@nanmicoder/dsh-agent-teams',
              enabled: true,
              source: {
                type: 'npm' as const,
                version: '0.1.21'
              }
            }
          }
        }
      }
    };
    const serialized = serializeManifest(manifest);
    expect(serialized.endsWith('\n')).toBe(true);
    expect(serialized.endsWith('\n\n')).toBe(false);

    const reloaded = loadManifest(serialized);
    expect(reloaded).toEqual(manifest);
  });

  it('should validate CaptureDocument schema', () => {
    const captureDoc = {
      apiVersion: 'dshenv-capture/v1' as const,
      manifest: {
        apiVersion: 'dshenv/v1' as const,
        profiles: {}
      },
      lock: {
        apiVersion: 'dshenv-lock/v1' as const,
        profiles: {}
      },
      warnings: ['warn1']
    };

    const parsed = CaptureDocumentSchema.parse(captureDoc);
    expect(parsed.apiVersion).toBe('dshenv-capture/v1');
    expect(parsed.warnings).toEqual(['warn1']);
  });
});
