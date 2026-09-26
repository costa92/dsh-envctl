import type { Command } from 'commander';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../environment/paths.js';

export interface CommandContext {
  program: Command;
  writeOut: (chunk: string) => void;
  setExitCode: (code: number) => void;
}

export function resolveCliPaths(opts: { dshHome?: string }): EnvironmentPaths {
  return resolveEnvironmentPaths({
    cliDshHome: opts.dshHome,
    envDshHome: process.env.DSH_HOME,
    cwd: process.cwd()
  });
}
