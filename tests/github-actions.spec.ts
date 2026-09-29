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
  if?: string;
  'continue-on-error'?: boolean;
}
interface Workflow {
  on?: unknown;
  permissions?: Record<string, string>;
  jobs: Record<
    string,
    {
      steps: Step[];
      strategy?: { matrix?: { node?: unknown[]; include?: Array<Record<string, unknown>> } };
      'continue-on-error'?: unknown;
      if?: string;
    }
  >;
}

const readWorkflow = (relative: string): Workflow =>
  YAML.parse(fs.readFileSync(path.join(projectDir, relative), 'utf8')) as Workflow;
const ci = readWorkflow('.github/workflows/ci.yml');
const example = readWorkflow('docs/examples/github-actions/dshenv-check.yml');
const release = readWorkflow('.github/workflows/release.yml');
const e2e = readWorkflow('.github/workflows/e2e.yml');
const compat = readWorkflow('.github/workflows/compat.yml');
const VERIFIED_DSH = '0.1.7-rc.2';
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
    fs.writeFileSync(path.join(profileDir, 'node_modules', 'teams-plugin', 'package.json'), JSON.stringify({ name: 'teams-plugin', version: '1.0.0', dsh: { bundle: {} } }));
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      JSON.stringify({ dependencies: { 'teams-plugin': '1.0.0' }, dsh: { profile: { bundles: ['teams-plugin'] } } })
    );

    const inSync = await runStep('drift', { DSH_HOME: dshHome });
    expect(inSync.exitCode).toBe(0);

    fs.writeFileSync(path.join(profileDir, 'node_modules', 'teams-plugin', 'package.json'), JSON.stringify({ name: 'teams-plugin', version: '0.9.0', dsh: { bundle: {} } }));
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

  it('runs on v* tags, and by hand as a publish check, with permission to create releases and an OIDC token for trusted publishing, after the same quality gates as CI', () => {
    expect(release.on).toEqual({ push: { tags: ['v*'] }, workflow_dispatch: null });
    expect(release.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    const runs = allSteps(release).flatMap((step) => (step.run && !step.id ? [step.run.trim()] : []));
    expect(runs.slice(0, 4)).toEqual(['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm test', 'pnpm build']);
    for (const id of ['verify-tag', 'notes']) {
      expect(allSteps(release).find((step) => step.id === id)?.if).toBe("github.event_name == 'push'");
    }
  });

  it('publishes a tag through trusted publishing first and with NPM_TOKEN only when that fails, before creating the GitHub release', () => {
    const steps = allSteps(release);
    const setupNode = steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with?.['registry-url']).toBe('https://registry.npmjs.org');
    const oidc = steps.findIndex((step) => step.id === 'publish-oidc');
    expect(steps[oidc]).toMatchObject({ if: "github.event_name == 'push'", 'continue-on-error': true });
    expect(steps[oidc].run?.trim()).toBe('npm publish ./dist/*.tgz --access public --loglevel verbose');
    expect(steps[oidc].env).toBeUndefined();
    const token = steps.findIndex((step) => step.id === 'publish-token');
    expect(steps[token].if).toBe("github.event_name == 'push' && steps.publish-oidc.outcome == 'failure'");
    expect(steps[token].env).toEqual({ NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' });
    expect(steps[token].run).toContain('::warning::');
    expect(steps[token].run).toContain('npm publish ./dist/*.tgz --access public --provenance --loglevel verbose');
    // Trusted publishing needs npm 11.5.1 or later; Node 22 bundles npm 10.
    const upgrade = steps.findIndex((step) => step.run?.trim() === 'npm install -g npm@^11.5.1');
    expect(upgrade).toBeGreaterThan(-1);
    expect(upgrade).toBeLessThan(oidc);
    expect(oidc).toBeLessThan(token);
    const create = steps.findIndex((step) => step.run?.startsWith('gh release create'));
    expect(token).toBeLessThan(create);
    expect(steps[create].if).toBe("github.event_name == 'push'");
  });

  it('checks by hand, without publishing, that trusted publishing gets a token and NPM_TOKEN still works', async () => {
    const steps = allSteps(release);
    const check = steps.find((step) => step.id === 'check-oidc')!;
    expect(check.if).toBe("github.event_name == 'workflow_dispatch'");
    expect(check.run).toContain('npm publish ./dist/*.tgz --dry-run --force --access public --loglevel verbose');
    const whoami = steps.find((step) => step.id === 'check-token')!;
    expect(whoami).toMatchObject({ if: "github.event_name == 'workflow_dispatch' && !cancelled()", env: { NODE_AUTH_TOKEN: '${{ secrets.NPM_TOKEN }}' } });
    expect(whoami.run?.trim()).toBe('npm whoami');

    const bin = path.join(workDir, 'bin');
    fs.mkdirSync(bin);
    const fakeNpm = (log: string) => fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(log)} >&2\n`, { mode: 0o755 });
    const env = { PATH: `${bin}:${process.env.PATH}` };
    fakeNpm('npm verbose oidc Successfully retrieved and set token');
    expect((await runStep('check-oidc', env, workDir)).exitCode).toBe(0);
    fakeNpm('npm verbose oidc Failed token exchange request with body message: OIDC token exchange error - package not found');
    const failed = await runStep('check-oidc', env, workDir);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain('::error::npm trusted publishing did not get a token: npm verbose oidc Failed token exchange');
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

describe('real DSH workflows', () => {
  it('runs the end-to-end script against the verified DSH on pushes and pull requests, apart from CI', () => {
    expect(Object.keys(e2e.on as object).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch']);
    expect(Object.keys(e2e.jobs)).toEqual(['e2e']);
    const run = allSteps(e2e).find((step) => step.run?.includes('scripts/e2e-dsh.sh'))?.run ?? '';
    expect(run).toContain(`inputs.dsh_version || '${VERIFIED_DSH}'`);
    expect(allSteps(ci).some((step) => step.run?.includes('e2e-dsh'))).toBe(false);
  });

  it('smoke-tests the verified DSH as a hard check and latest and next as reports only', () => {
    const smoke = compat.jobs.smoke;
    expect(smoke.strategy?.matrix?.include).toEqual([
      { dsh: VERIFIED_DSH, informational: false },
      { dsh: 'latest', informational: true },
      { dsh: 'next', informational: true }
    ]);
    expect(smoke['continue-on-error']).toBe('${{ matrix.informational }}');
    expect(smoke.steps.at(-1)?.run).toBe('scripts/smoke-dsh.sh "${{ matrix.dsh }}" "$RUNNER_TEMP/smoke"');
    expect(Object.keys(compat.on as object)).toContain('schedule');
  });

  it('pins the same verified DSH as the version gate', async () => {
    const { knownDshFamily } = await import('../src/dsh/version.js');
    expect(knownDshFamily(VERIFIED_DSH)).toBe('0.1.7');
  });

  it.each(['scripts/e2e-dsh.sh', 'scripts/smoke-dsh.sh'])('keeps %s executable', (script) => {
    expect(fs.statSync(path.join(projectDir, script)).mode & 0o111).not.toBe(0);
  });
});
