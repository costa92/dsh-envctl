import * as path from 'node:path';
import * as os from 'node:os';
import { ValidationError } from '../errors.js';

export interface EnvironmentPaths {
  home: string;
  profilesDir: string;
  managerDir: string;
  manifestFile: string;
  lockFile: string;
  stateFile: string;
  backupsDir: string;
  logsDir: string;
  trashDir: string;
}

export interface ResolvePathsInput {
  cliDshHome?: string;
  envDshHome?: string;
  userHome?: string;
}

export function resolveEnvironmentPaths(input?: ResolvePathsInput): EnvironmentPaths {
  const userHome = input?.userHome ?? os.homedir();
  let explicitHome: string | undefined;

  if (input?.cliDshHome !== undefined) {
    if (!input.cliDshHome.trim()) {
      throw new ValidationError('CLI dsh-home path must not be empty');
    }
    if (!path.isAbsolute(input.cliDshHome)) {
      throw new ValidationError(`CLI dsh-home must be an absolute path: ${input.cliDshHome}`);
    }
    explicitHome = path.normalize(input.cliDshHome);
  } else if (input?.envDshHome !== undefined) {
    if (!input.envDshHome.trim()) {
      throw new ValidationError('DSH_HOME environment variable must not be empty');
    }
    if (!path.isAbsolute(input.envDshHome)) {
      throw new ValidationError(`DSH_HOME must be an absolute path: ${input.envDshHome}`);
    }
    explicitHome = path.normalize(input.envDshHome);
  }

  const home = explicitHome ?? path.join(userHome, '.dsh');
  const profilesDir = path.join(home, 'profiles');
  const managerDir = path.join(home, 'envctl');

  return {
    home,
    profilesDir,
    managerDir,
    manifestFile: path.join(managerDir, 'manifest.yaml'),
    lockFile: path.join(managerDir, 'lock.json'),
    stateFile: path.join(managerDir, 'state.json'),
    backupsDir: path.join(managerDir, 'backups'),
    logsDir: path.join(managerDir, 'logs'),
    trashDir: path.join(managerDir, 'trash')
  };
}
