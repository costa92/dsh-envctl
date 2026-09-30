import * as os from 'node:os';
import { execa } from 'execa';
import { awaitWithTreeTimeout } from '../io/process-tree.js';

export type NpmVersionCheck =
  | { status: 'exists' }
  | { status: 'missing'; latest?: string }
  // reachable: npm answered, but could not tell (a package it cannot see may be private); otherwise npm never answered.
  | { status: 'unknown'; reason: string; reachable: boolean };

// A check that only saves a failed apply must not hold an install up for long, online or offline.
const NPM_VIEW_TIMEOUT_MS = 5_000;

async function npmView(args: string[], timeoutMs: number) {
  // Run from the home directory, like self-update, so a project .npmrc in the current directory picks no registry.
  // `--` keeps a spec from being read as an npm option.
  const subprocess = execa('npm', ['view', '--', ...args, '--fetch-retries=0'], { cwd: os.homedir(), reject: false, stdin: 'ignore' });
  const { result, timedOut } = await awaitWithTreeTimeout(subprocess, timeoutMs);
  return { ...result, timedOut };
}

function npmErrorCode(stderr: unknown): string | undefined {
  return /\bE(404|401|403)\b/.exec(String(stderr))?.[0];
}

// Whether npm has this exact version. Only a version missing from a package npm does have is certain; the rest
// (offline, no npm, a package npm cannot see, which may be private) never blocks an install.
export async function checkNpmVersion(packageName: string, version: string, options: { timeoutMs?: number } = {}): Promise<NpmVersionCheck> {
  const timeoutMs = options.timeoutMs ?? NPM_VIEW_TIMEOUT_MS;
  const exact = await npmView([`${packageName}@${version}`, 'version', '--json'], timeoutMs);
  if (exact.timedOut || (exact.failed && exact.exitCode === undefined)) {
    return { status: 'unknown', reason: exact.timedOut ? 'npm view timed out' : 'npm could not be run', reachable: false };
  }
  if (exact.exitCode === 0 && String(exact.stdout).trim() !== '') {
    return { status: 'exists' };
  }
  const code = exact.exitCode === 0 ? undefined : npmErrorCode(exact.stderr);
  if (exact.exitCode !== 0 && code !== 'E404') {
    return code
      ? { status: 'unknown', reason: `npm answered ${code}`, reachable: true }
      : { status: 'unknown', reason: 'npm view failed', reachable: false };
  }
  // npm answers an unknown version with nothing or, since npm 10, with E404 as for an unknown package.
  const latest = await npmView([packageName, 'version'], timeoutMs);
  if (latest.timedOut) {
    return { status: 'unknown', reason: 'npm view timed out', reachable: false };
  }
  const latestVersion = latest.exitCode === 0 ? String(latest.stdout).trim() : '';
  if (latestVersion) {
    return { status: 'missing', latest: latestVersion };
  }
  return { status: 'unknown', reason: 'npm cannot see the package', reachable: true };
}
