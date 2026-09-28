import * as fs from 'node:fs';
import * as path from 'node:path';

export function writeOverlayFixture(tempHome: string): void {
  const envctl = path.join(tempHome, 'envctl');
  fs.mkdirSync(path.join(envctl, 'overlays'), { recursive: true });
  fs.writeFileSync(
    path.join(envctl, 'manifest.yaml'),
    `apiVersion: dshenv/v1
profiles:
  web:
    plugins:
      shared:
        package: shared-plugin
        source: { type: npm, version: "1.0.0" }
      heavy:
        package: heavy-plugin
        source: { type: npm, version: "1.0.0" }
`
  );
  fs.writeFileSync(
    path.join(envctl, 'overlays', 'laptop.yaml'),
    `apiVersion: dshenv-overlay/v1
profiles:
  web:
    plugins:
      heavy:
        remove: true
      extra:
        package: extra-plugin
        source: { type: npm, version: "2.0.0" }
`
  );
  const profileDir = path.join(tempHome, 'profiles', 'web');
  for (const name of ['shared-plugin', 'heavy-plugin']) {
    fs.mkdirSync(path.join(profileDir, 'node_modules', name), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: {} } }));
  }
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    JSON.stringify({
      dependencies: { 'shared-plugin': '1.0.0', 'heavy-plugin': '1.0.0' },
      dsh: { profile: { bundles: ['shared-plugin', 'heavy-plugin'] } }
    })
  );
}
