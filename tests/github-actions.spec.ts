import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import * as YAML from 'yaml';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface Step {
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Workflow {
  on?: unknown;
  permissions?: Record<string, string>;
  jobs: Record<string, { steps: Step[]; strategy?: { matrix?: { node?: unknown[] } } }>;
}

const readWorkflow = (relative: string): Workflow =>
  YAML.parse(fs.readFileSync(path.join(projectDir, relative), 'utf8')) as Workflow;
const ci = readWorkflow('.github/workflows/ci.yml');
const example = readWorkflow('docs/examples/github-actions/dshenv-check.yml');
const release = readWorkflow('.github/workflows/release.yml');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8')) as {
  version: string;
  scripts: Record<string, string>;
};

const allSteps = (workflow: Workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps);
const pnpmVersions = (workflow: Workflow) =>
  allSteps(workflow)
    .filter((step) => step.uses?.startsWith('pnpm/action-setup@'))
    .map((step) => String(step.with?.version));
const stepScript = (workflow: Workflow, id: string): string => {
  const step = allSteps(workflow).find((candidate) => candidate.id === id);
  if (!step?.run) throw new Error(`No run step with id ${id}`);
  return step.run;
};

describe('repository CI workflow', () => {
  it('runs every quality gate from package.json on a frozen lockfile', () => {
    const runs = allSteps(ci).flatMap((step) => (step.run ? [step.run.trim()] : []));
    expect(runs).toEqual(['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm test', 'pnpm build']);
    for (const run of runs.slice(1)) {
      expect(packageJson.scripts).toHaveProperty(run.split(' ')[1]);
    }
  });

  it('pins one exact pnpm version, shared with the example, and covers both supported Node majors', async () => {
    const versions = [...pnpmVersions(ci), ...pnpmVersions(example), ...pnpmVersions(release)];
    expect(new Set(versions).size).toBe(1);
    expect(versions[0]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ci.jobs.check.strategy?.matrix?.node).toEqual([22, 24]);
  });
});

describe('dshenv example workflow scripts', () => {
  let workDir: string;
  let dshenv: string;

  const runStep = (id: string, env: Record<string, string>) =>
    execa('bash', ['-c', stepScript(example, id)], { cwd: projectDir, env: { ...process.env, DSHENV: dshenv, ...env }, reject: false });

  const writeConfig = (home: string, overlays: Record<string, string>) => {
    fs.mkdirSync(path.join(home, 'envctl', 'overlays'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'envctl', 'manifest.yaml'),
      'apiVersion: dshenv/v1\nprofiles:\n  web:\n    plugins:\n      teams: { package: teams-plugin, source: { type: npm, version: "1.0.0" } }\n'
    );
    for (const [name, content] of Object.entries(overlays)) {
      fs.writeFileSync(path.join(home, 'envctl', 'overlays', `${name}.yaml`), content);
    }
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-gha-'));
    const shim = path.join(workDir, 'dshenv.mts');
    fs.writeFileSync(
      shim,
      `import { runCli } from ${JSON.stringify(path.join(projectDir, 'src', 'cli.ts'))};\nprocess.exitCode = await runCli(process.argv.slice(2));\n`
    );
    dshenv = `node --import tsx ${shim}`;
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('validate passes for a valid base and overlays, and fails on an overlay that cannot merge', async () => {
    const configHome = path.join(workDir, 'config');
    writeConfig(configHome, { laptop: 'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      teams: { enabled: false }\n' });

    const ok = await runStep('validate', { CONFIG_HOME: configHome });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain('::group::overlay laptop');

    fs.writeFileSync(
      path.join(configHome, 'envctl', 'overlays', 'broken.yaml'),
      'apiVersion: dshenv-overlay/v1\nprofiles:\n  web:\n    plugins:\n      teams: { source: { type: npm, version: "^2.0.0" } }\n'
    );
    expect((await runStep('validate', { CONFIG_HOME: configHome })).exitCode).not.toBe(0);
    expect(fs.readdirSync(path.join(configHome, 'envctl')).sort()).toEqual(['manifest.yaml', 'overlays']);
  }, 60000);

  it('drift passes when the environment matches and fails with an annotation when it drifted', async () => {
    const dshHome = path.join(workDir, 'dsh');
    writeConfig(dshHome, {});
    const profileDir = path.join(dshHome, 'profiles', 'web');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'teams-plugin'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'node_modules', 'teams-plugin', 'package.json'), JSON.stringify({ name: 'teams-plugin', version: '1.0.0' }));
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'teams-plugin': '1.0.0' }, dsh: { profile: { bundles: ['teams-plugin'] } } })
    );

    const inSync = await runStep('drift', { DSH_HOME: dshHome });
    expect(inSync.exitCode).toBe(0);

    fs.writeFileSync(path.join(profileDir, 'node_modules', 'teams-plugin', 'package.json'), JSON.stringify({ name: 'teams-plugin', version: '0.9.0' }));
    const drifted = await runStep('drift', { DSH_HOME: dshHome });
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stdout).toContain('::error::');
  }, 60000);
});

describe('release workflow', () => {
  let workDir: string;

  const runStep = (id: string, env: Record<string, string>, cwd = projectDir) =>
    execa('bash', ['-c', stepScript(release, id)], { cwd, env: { ...process.env, ...env }, reject: false });

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-release-'));
  });

  afterEach(() => {
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('runs on v* tags with permission to create releases and sign provenance, after the same quality gates as CI', () => {
    expect(release.on).toEqual({ push: { tags: ['v*'] } });
    expect(release.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    const runs = allSteps(release).flatMap((step) => (step.run && !step.id ? [step.run.trim()] : []));
    expect(runs.slice(0, 4)).toEqual(['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm test', 'pnpm build']);
  });

  it('publishes the packed tarball to npm with provenance before creating the GitHub release', () => {
    const steps = allSteps(release);
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with?.['registry-url']).toBe('https://registry.npmjs.org');
    const publish = steps.findIndex((step) => step.run?.trim() === 'npm publish dist/*.tgz --access public --provenance');
    expect(publish).toBeGreaterThan(-1);
    expect(steps[publish].env).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' });
    expect(publish).toBeLessThan(steps.findIndex((step) => step.run?.startsWith('gh release create')));
  });

  it('accepts only the tag that matches the package.json version', async () => {
    expect((await runStep('verify-tag', { GITHUB_REF_NAME: `v${packageJson.version}` })).exitCode).toBe(0);
    const mismatch = await runStep('verify-tag', { GITHUB_REF_NAME: 'v99.0.0' });
    expect(mismatch.exitCode).toBe(1);
    expect(mismatch.stderr).toContain(`Tag v99.0.0 does not match package.json version ${packageJson.version}`);
  });

  it('takes the release notes from the CHANGELOG section of the tagged version', async () => {
    fs.writeFileSync(
      path.join(workDir, 'CHANGELOG.md'),
      '# Changelog\n\n## 1.1.0 - 2026-10-01\n\n- newer\n\n## 1.0.0 - 2026-09-27\n\n### Added\n\n- first\n'
    );
    expect((await runStep('notes', { GITHUB_REF_NAME: 'v1.0.0' }, workDir)).exitCode).toBe(0);
    expect(fs.readFileSync(path.join(workDir, 'release-notes.md'), 'utf8').trim()).toBe('### Added\n\n- first');

    const missing = await runStep('notes', { GITHUB_REF_NAME: 'v2.0.0' }, workDir);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('CHANGELOG.md has no section for 2.0.0');
  });

  it('has a CHANGELOG section for the current package.json version', async () => {
    fs.copyFileSync(path.join(projectDir, 'CHANGELOG.md'), path.join(workDir, 'CHANGELOG.md'));
    expect((await runStep('notes', { GITHUB_REF_NAME: `v${packageJson.version}` }, workDir)).exitCode).toBe(0);
  });
});
