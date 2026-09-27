import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A dsh on the developer's PATH must never run in tests: its --dump-config writes profile files and its
// hot reload state differs per machine. This stub shadows it, and a DSH_CLI exported in the developer's
// shell is dropped for the same reason; tests that need DSH set DSH_CLI to a fake.
export default function setup(): () => void {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-test-bin-'));
  fs.writeFileSync(path.join(binDir, 'dsh'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  const originalDshCli = process.env.DSH_CLI;
  delete process.env.DSH_CLI;
  return () => {
    if (originalDshCli !== undefined) process.env.DSH_CLI = originalDshCli;
    fs.rmSync(binDir, { recursive: true, force: true });
  };
}
