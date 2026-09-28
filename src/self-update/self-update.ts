import * as fs from 'node:fs';
import * as path from 'node:path';
import { execa } from 'execa';
import { DshError, ValidationError } from '../errors.js';
import { ExactVersionRegex } from '../manifest/schema.js';

export const PACKAGE_NAME = '@costa92/dshenv';
const LOOKUP_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;

export type InstallMethod = 'npm' | 'pnpm';

export interface RunResult {
  exitCode?: number;
  stdout: string;
  stderr: string;
}

export type Runner = (file: string, args: string[], timeoutMs: number) => Promise<RunResult>;

export const defaultRunner: Runner = async (file, args, timeoutMs) => {
  const result = await execa(file, args, { reject: false, shell: false, timeout: timeoutMs });
  return { exitCode: result.exitCode, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
};

export interface SelfUpdateOptions {
  currentVersion: string;
  packageRoot: string;
  to?: string;
  check?: boolean;
  run?: Runner;
}

export interface SelfUpdateResult {
  status: 'up-to-date' | 'available' | 'updated';
  current: string;
  target: string;
  method?: InstallMethod;
  command?: string;
}

function firstErrorLine(result: RunResult): string {
  return result.stderr.split('\n').find((line) => line.trim() !== '')?.trim() ?? `exit code ${String(result.exitCode)}`;
}

// --prefer-online: a cached packument can lag a fresh release by minutes and report it as missing.
export async function resolveTargetVersion(run: Runner, to?: string): Promise<string> {
  if (to !== undefined && !ExactVersionRegex.test(to)) {
    throw new ValidationError(`--to must be an exact version such as 0.2.0, got '${to}'`);
  }
  const result = await run('npm', ['view', `${PACKAGE_NAME}@${to ?? 'latest'}`, 'version', '--prefer-online'], LOOKUP_TIMEOUT_MS);
  const version = result.stdout.trim().split('\n').at(-1)?.trim().replace(/^'|'$/g, '') ?? '';
  if (result.exitCode !== 0 || !ExactVersionRegex.test(version)) {
    throw new DshError(`Could not look up ${PACKAGE_NAME}@${to ?? 'latest'} on the npm registry: ${firstErrorLine(result)}`);
  }
  return version;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function realpathOrSelf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

// Only a global npm or pnpm install can be replaced in place; a linked checkout must be updated with git.
export async function detectInstallMethod(run: Runner, packageRoot: string): Promise<InstallMethod | null> {
  const root = realpathOrSelf(packageRoot);
  for (const method of ['npm', 'pnpm'] as const) {
    const result = await run(method, ['root', '-g'], LOOKUP_TIMEOUT_MS).catch(() => null);
    const globalRoot = result?.exitCode === 0 ? result.stdout.trim() : '';
    if (globalRoot && isInside(realpathOrSelf(globalRoot), root)) {
      return method;
    }
  }
  return null;
}

export function installArgs(method: InstallMethod, version: string): string[] {
  return method === 'npm'
    ? ['install', '-g', `${PACKAGE_NAME}@${version}`, '--prefer-online']
    : ['add', '-g', `${PACKAGE_NAME}@${version}`];
}

export async function selfUpdate(options: SelfUpdateOptions): Promise<SelfUpdateResult> {
  const run = options.run ?? defaultRunner;
  const current = options.currentVersion;
  const target = await resolveTargetVersion(run, options.to);
  if (target === current) {
    return { status: 'up-to-date', current, target };
  }
  if (options.check) {
    return { status: 'available', current, target };
  }

  const method = await detectInstallMethod(run, options.packageRoot);
  if (!method) {
    throw new ValidationError(
      `dshenv at ${options.packageRoot} was not installed globally with npm or pnpm, so it cannot replace itself; ` +
        `run 'npm install -g ${PACKAGE_NAME}@${target}', or 'git pull && pnpm build' in a linked checkout`
    );
  }
  const args = installArgs(method, target);
  const command = [method, ...args].join(' ');
  const result = await run(method, args, INSTALL_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new DshError(`'${command}' failed: ${firstErrorLine(result)}`);
  }
  return { status: 'updated', current, target, method, command };
}
