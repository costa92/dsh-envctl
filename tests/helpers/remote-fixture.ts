import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveEnvironmentPaths, type EnvironmentPaths } from '../../src/environment/paths.js';
import { loadLock } from '../../src/manifest/files.js';
import { lockEntryDigests } from '../../src/remote/lock-entries.js';
import { sha256Hex, writeRemoteConfig } from '../../src/remote/schema.js';

export const FIXTURE_REMOTE_URL = 'file:///nonexistent/team.git';

export const OWNED_MANIFEST = `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      shared:
        package: shared-plugin
        source: { type: npm, version: "1.0.0" }
      demo:
        package: demo-plugin
        source: { type: git, url: "file:///nonexistent/demo-plugin.git" }
`;

export const OWNED_LOCK = `${JSON.stringify(
  {
    apiVersion: 'dshenv-lock/v1',
    profiles: {
      web: {
        plugins: {
          shared: { package: 'shared-plugin', source: { type: 'npm', resolvedVersion: '1.0.0' } },
          demo: { package: 'demo-plugin', source: { type: 'git', url: 'file:///nonexistent/demo-plugin.git', commit: 'b'.repeat(40) } }
        }
      }
    }
  },
  null,
  2
)}\n`;

export const OWNED_OVERLAY = `apiVersion: dshenv-overlay/v1
profiles:
  web:
    plugins:
      shared:
        enabled: false
`;

export const LOCAL_OVERLAY = 'apiVersion: dshenv-overlay/v1\n';

// The state `remote add --yes` leaves behind: manifest, overlays/team.yaml and both lock entries owned, overlays/mine.yaml local.
export async function writeRemoteOwnedFixture(home: string): Promise<EnvironmentPaths> {
  const paths = resolveEnvironmentPaths({ cliDshHome: home });
  fs.mkdirSync(paths.overlaysDir, { recursive: true });
  fs.writeFileSync(paths.manifestFile, OWNED_MANIFEST);
  fs.writeFileSync(paths.lockFile, OWNED_LOCK);
  fs.writeFileSync(path.join(paths.overlaysDir, 'team.yaml'), OWNED_OVERLAY);
  fs.writeFileSync(path.join(paths.overlaysDir, 'mine.yaml'), LOCAL_OVERLAY);
  await writeRemoteConfig(paths, {
    apiVersion: 'dshenv-remote/v1',
    url: FIXTURE_REMOTE_URL,
    branch: 'main',
    path: 'envctl',
    commit: 'a'.repeat(40),
    files: {
      'manifest.yaml': sha256Hex(OWNED_MANIFEST),
      'overlays/team.yaml': sha256Hex(OWNED_OVERLAY)
    },
    lockEntries: lockEntryDigests(loadLock(OWNED_LOCK))
  });
  return paths;
}
