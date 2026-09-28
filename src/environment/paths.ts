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
  overlaysDir: string;
  overlaySelectionFile: string;
  remoteFile: string;
  remoteDir: string;
  // Skills the manifest declares, and the $DSH_HOME/skills directory DSH loads loose skills from.
  skillsDir: string;
  dshSkillsDir: string;
}

export interface ResolvePathsInput {
  cliDshHome?: string;
  envDshHome?: string;
  userHome?: string;
  cwd?: string;
}

function resolveHomePath(value: string, label: string, cwd: string): string {
  if (!value.trim()) {
    throw new ValidationError(`${label} must not be empty`);
  }
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

export function resolveEnvironmentPaths(input?: ResolvePathsInput): EnvironmentPaths {
  const userHome = input?.userHome ?? os.homedir();
  const cwd = input?.cwd ?? process.cwd();
  let explicitHome: string | undefined;

  if (input?.cliDshHome !== undefined) {
    explicitHome = resolveHomePath(input.cliDshHome, 'CLI dsh-home', cwd);
  } else if (input?.envDshHome !== undefined) {
    explicitHome = resolveHomePath(input.envDshHome, 'DSH_HOME environment variable', cwd);
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
    trashDir: path.join(managerDir, 'trash'),
    overlaysDir: path.join(managerDir, 'overlays'),
    overlaySelectionFile: path.join(managerDir, 'overlay-selection.json'),
    remoteFile: path.join(managerDir, 'remote.json'),
    remoteDir: path.join(managerDir, 'remote'),
    skillsDir: path.join(managerDir, 'skills'),
    dshSkillsDir: path.join(home, 'skills')
  };
}
