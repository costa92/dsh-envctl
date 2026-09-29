import * as os from 'node:os';
import { execa } from 'execa';

export type NpmVersionCheck =
  | { status: 'exists' }
  | { status: 'missing'; what: 'package' | 'version'; latest?: string }
  | { status: 'unknown'; reason: string };

const NPM_VIEW_TIMEOUT_MS = 15_000;

async function npmView(args: string[]) {
  // Run from the home directory, like self-update, so a project .npmrc in the current directory picks no registry.
  return execa('npm', ['view', ...args], { cwd: os.homedir(), reject: false, timeout: NPM_VIEW_TIMEOUT_MS, stdin: 'ignore' });
}

// Whether npm has this exact version; 'unknown' (offline, no npm, a private registry without auth) never blocks an install.
export async function checkNpmVersion(packageName: string, version: string): Promise<NpmVersionCheck> {
  const result = await npmView([`${packageName}@${version}`, 'version', '--json']);
  if (result.failed && result.exitCode === undefined) {
    return { status: 'unknown', reason: result.timedOut ? 'npm view timed out' : 'npm could not be run' };
  }
  if (result.exitCode !== 0) {
    if (/E404/.test(String(result.stderr))) {
      return { status: 'missing', what: 'package' };
    }
    return { status: 'unknown', reason: 'npm view failed' };
  }
  if (String(result.stdout).trim() !== '') {
    return { status: 'exists' };
  }
  const latest = await npmView([packageName, 'version']);
  const latestVersion = latest.exitCode === 0 ? String(latest.stdout).trim() : '';
  return { status: 'missing', what: 'version', ...(latestVersion ? { latest: latestVersion } : {}) };
}
