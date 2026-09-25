import { describe, it, expect } from 'vitest';
import { resolveEnvironmentPaths } from '../../src/environment/paths.js';

describe('resolveEnvironmentPaths', () => {
  const userHome = '/Users/costalong';

  it('should resolve default path from user home', () => {
    const paths = resolveEnvironmentPaths({ userHome });
    expect(paths.home).toBe('/Users/costalong/.dsh');
    expect(paths.profilesDir).toBe('/Users/costalong/.dsh/profiles');
    expect(paths.managerDir).toBe('/Users/costalong/.dsh/envctl');
    expect(paths.manifestFile).toBe('/Users/costalong/.dsh/envctl/manifest.yaml');
    expect(paths.lockFile).toBe('/Users/costalong/.dsh/envctl/lock.json');
    expect(paths.stateFile).toBe('/Users/costalong/.dsh/envctl/state.json');
    expect(paths.backupsDir).toBe('/Users/costalong/.dsh/envctl/backups');
    expect(paths.logsDir).toBe('/Users/costalong/.dsh/envctl/logs');
    expect(paths.trashDir).toBe('/Users/costalong/.dsh/envctl/trash');
  });

  it('should prioritize cliDshHome over env and default', () => {
    const paths = resolveEnvironmentPaths({
      cliDshHome: '/custom/cli-dsh',
      envDshHome: '/custom/env-dsh',
      userHome
    });
    expect(paths.home).toBe('/custom/cli-dsh');
    expect(paths.profilesDir).toBe('/custom/cli-dsh/profiles');
    expect(paths.managerDir).toBe('/custom/cli-dsh/envctl');
  });

  it('should prioritize envDshHome over default when cli is not provided', () => {
    const paths = resolveEnvironmentPaths({
      envDshHome: '/custom/env-dsh',
      userHome
    });
    expect(paths.home).toBe('/custom/env-dsh');
    expect(paths.profilesDir).toBe('/custom/env-dsh/profiles');
  });

  it('should reject non-absolute explicit dshHome path', () => {
    expect(() => {
      resolveEnvironmentPaths({
        cliDshHome: 'relative/path',
        userHome
      });
    }).toThrow(/absolute/i);

    expect(() => {
      resolveEnvironmentPaths({
        envDshHome: 'relative/env/path',
        userHome
      });
    }).toThrow(/absolute/i);
  });

  it('should reject empty explicit path', () => {
    expect(() => {
      resolveEnvironmentPaths({
        cliDshHome: '   ',
        userHome
      });
    }).toThrow();
  });
});
