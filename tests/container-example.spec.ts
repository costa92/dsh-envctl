import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleDir = path.join(projectDir, 'docs', 'examples', 'container');
const read = (name: string) => fs.readFileSync(path.join(exampleDir, name), 'utf8');

const dockerfile = read('Dockerfile');
const argDefault = (name: string): string | undefined =>
  dockerfile.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];
const ciPnpmVersion = String(
  (YAML.parse(fs.readFileSync(path.join(projectDir, '.github', 'workflows', 'ci.yml'), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ uses?: string; with?: { version?: unknown } }> }>;
  }).jobs.check.steps.find((step) => step.uses?.startsWith('pnpm/action-setup@'))?.with?.version
);

describe('container example', () => {
  it('pins the DSH and pnpm versions dshenv supports', () => {
    expect(argDefault('DSH_VERSION')).toBe('0.1.7-rc.2');
    expect(argDefault('PNPM_VERSION')).toBe(ciPnpmVersion);
    expect(argDefault('NODE_VERSION')).toBe('22');
    expect(dockerfile).toMatch(/npm install -g .*"@deepseek-ai\/dsh@\$\{DSH_VERSION\}"/);
  });

  it('applies the manifest as a non-root user and fails the build on drift', () => {
    expect(dockerfile).toMatch(/^USER dsh$/m);
    expect(dockerfile).toMatch(/^ENV DSH_HOME=\/home\/dsh\/\.dsh$/m);
    expect(dockerfile).toContain('dshenv apply --yes');
    expect(dockerfile).toContain('dshenv plan');
    expect(dockerfile.indexOf('USER dsh')).toBeLessThan(dockerfile.indexOf('dshenv apply --yes'));
    expect(dockerfile).toMatch(/COPY --from=dshenv /);
  });

  it('starts dsh web without --host and trusts only loopback authorities', () => {
    const cmd = dockerfile.match(/^CMD (\[.*\])$/m)?.[1];
    expect(cmd).toBeDefined();
    const argv = JSON.parse(cmd as string) as string[];
    expect(argv.slice(0, 3)).toEqual(['dsh', 'web', '--no-open']);
    expect(argv).not.toContain('--host');
    const trusted = argv.flatMap((arg, i) => (argv[i - 1] === '--trusted-host' ? [arg] : []));
    expect(trusted.sort()).toEqual(['127.0.0.1:3080', 'localhost:3080']);
  });

  it('binds the webserver to all container interfaces while restating its full config', () => {
    const rows = YAML.parse(read('cordis.patch.yml')) as Array<Record<string, unknown>>;
    const webserver = rows.find((row) => row.id === 'webserver');
    expect(webserver).toEqual({
      id: 'webserver',
      config: { host: '0.0.0.0', port: 3080, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 }
    });
  });

  it('publishes the port to host loopback only and keeps secrets out of the build', () => {
    const compose = YAML.parse(read('compose.yaml')) as {
      services: Record<string, { ports?: string[]; environment?: Record<string, string>; build?: { args?: Record<string, string> } }>;
    };
    const ports = Object.values(compose.services).flatMap((service) => service.ports ?? []);
    expect(ports.length).toBeGreaterThan(0);
    for (const port of ports) {
      expect(port.startsWith('127.0.0.1:')).toBe(true);
    }
    for (const service of Object.values(compose.services)) {
      expect(JSON.stringify(service.build?.args ?? {})).not.toMatch(/KEY|TOKEN|SECRET/i);
    }
    expect(dockerfile).not.toMatch(/DEEPSEEK_API_KEY|ARG .*KEY|ARG .*TOKEN/i);
  });
});
