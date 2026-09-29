import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A dsh on the developer's PATH must never run in tests: its --dump-config writes profile files and its
// hot reload state differs per machine. This stub shadows it, and a DSH_CLI exported in the developer's
// shell is dropped for the same reason; tests that need DSH set DSH_CLI to a fake.
export default function setup(): () => void {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-test-bin-'));
  fs.writeFileSync(path.join(binDir, 'dsh'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  // Windows finds commands through PATHEXT, so there the stub is the dsh.cmd an npm install would put first.
  fs.writeFileSync(path.join(binDir, 'dsh.cmd'), '@exit /b 127\r\n');
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  const originalDshCli = process.env.DSH_CLI;
  delete process.env.DSH_CLI;
  // A default profile exported in the developer's shell would fill in every -p the tests leave out.
  const originalProfile = process.env.DSHENV_PROFILE;
  delete process.env.DSHENV_PROFILE;
  // Commits made in tests must not depend on the developer's git identity or on signing being set up.
  const gitConfig = Object.entries({ 'user.name': 'dshenv-test', 'user.email': 'test@example.invalid', 'commit.gpgsign': 'false', 'tag.gpgsign': 'false' });
  process.env.GIT_CONFIG_COUNT = String(gitConfig.length);
  gitConfig.forEach(([key, value], index) => {
    process.env[`GIT_CONFIG_KEY_${index}`] = key;
    process.env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return () => {
    if (originalDshCli !== undefined) process.env.DSH_CLI = originalDshCli;
    if (originalProfile !== undefined) process.env.DSHENV_PROFILE = originalProfile;
    fs.rmSync(binDir, { recursive: true, force: true });
  };
}
