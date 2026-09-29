import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { dshWebState, launchDshWeb, startDshWeb, stopProcessGroup } from '../../src/dsh/web-server.js';
import { execa } from 'execa';

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('startDshWeb', () => {
  let dir: string;
  const fakeDsh = (body: string) => {
    const file = path.join(dir, 'fake-dsh.mjs');
    fs.writeFileSync(file, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(process.pid));\n${body}`);
    return { file: process.execPath, args: [file] };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-web-server-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts dsh web for the profile on a free port, reads the URL it prints, and stops it', async () => {
    const command = fakeDsh(`
fs.writeFileSync(${JSON.stringify(path.join(dir, 'call.json'))}, JSON.stringify({ args: process.argv.slice(2), home: process.env.DSH_HOME }));
console.log('starting');
setTimeout(() => console.log('dsh web: http://127.0.0.1:4567/?token=abc-DEF_1'), 100);
setInterval(() => {}, 1000);
`);
    const web = await startDshWeb('web', { command, dshHome: '/tmp/some-home', timeoutMs: 10_000 });
    const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
    try {
      expect(web.url).toBe('http://127.0.0.1:4567/?token=abc-DEF_1');
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'call.json'), 'utf8'))).toEqual({
        args: ['--profile', 'web', '--no-open', '--port', '0'],
        home: '/tmp/some-home'
      });
      expect(alive(pid)).toBe(true);
    } finally {
      await web.stop();
    }
    expect(alive(pid)).toBe(false);
  });

  it('waits for everything DSH started to stop, not just DSH itself', async () => {
    const childPid = path.join(dir, 'child-pid');
    const command = fakeDsh(`
import { spawn } from 'node:child_process';
// Like an MCP server DSH starts: it takes a moment to exit on SIGTERM, after DSH itself is gone.
const pidFile = ${JSON.stringify(path.join(dir, 'child-pid'))};
spawn(process.execPath, ['-e', \`process.on('SIGTERM', () => setTimeout(() => process.exit(0), 500)); require('fs').writeFileSync(\${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)\`], { stdio: 'ignore' });
const ready = setInterval(() => {
  if (fs.existsSync(pidFile)) {
    clearInterval(ready);
    console.log('dsh web: http://127.0.0.1:4567/?token=abc');
  }
}, 20);
setInterval(() => {}, 1000);
`);
    const web = await startDshWeb('web', { command, dshHome: dir, timeoutMs: 10_000 });
    const grandchild = Number(fs.readFileSync(childPid, 'utf8'));
    try {
      expect(alive(grandchild)).toBe(true);
    } finally {
      await web.stop();
    }
    expect(alive(grandchild)).toBe(false);
  });

  it('reports the first error line when DSH exits before serving, as a profile without a web app does', async () => {
    const command = fakeDsh(`console.error("error: unknown option '--no-open'"); process.exit(1);`);
    await expect(startDshWeb('headless', { command, dshHome: dir, timeoutMs: 10_000 })).rejects.toThrow(
      /dsh --profile headless did not start dsh web: error: unknown option '--no-open'/
    );
  });

  it('skips the script line and the ELIFECYCLE line pnpm wraps around a source checkout error', async () => {
    const command = fakeDsh(`
console.error('$ node --import tsx/esm apps/cli/src/bin.ts --profile headless --no-open --port 0');
console.error("error: unknown option '--no-open'");
console.error('[ELIFECYCLE] Command failed with exit code 1.');
process.exit(1);
`);
    const failure = startDshWeb('headless', { command, dshHome: dir, timeoutMs: 10_000 });
    await expect(failure).rejects.toThrow(/did not start dsh web: error: unknown option '--no-open'$/);
  });

  it('never quotes a login token DSH printed before it failed', async () => {
    const command = fakeDsh(`console.error('dsh web: http://localhost:4567/?token=SECRET-1 is unreachable'); process.exit(1);`);
    const failure = startDshWeb('web', { command, dshHome: dir, timeoutMs: 10_000 });
    await expect(failure).rejects.toThrow(/did not start dsh web: dsh web: http:\/\/localhost:4567\/\?token=<redacted> is unreachable$/);
  });

  it('gives up and stops DSH when no URL appears in time', async () => {
    const command = fakeDsh(`setInterval(() => {}, 1000);`);
    await expect(startDshWeb('web', { command, dshHome: dir, timeoutMs: 500 })).rejects.toThrow(/did not print a dsh web URL within 500 ms/);
    expect(alive(Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8')))).toBe(false);
  });

  it('refuses when no DSH CLI was found', async () => {
    await expect(startDshWeb('web', { command: null, dshHome: dir })).rejects.toThrow(/DSH CLI was not found/);
  });
});

describe('launchDshWeb', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-web-launch-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves dsh web running on its own, logging to a private file, until it is stopped', async () => {
    const script = path.join(dir, 'fake-dsh.mjs');
    fs.writeFileSync(script, `console.log('ready'); console.log('dsh web: http://127.0.0.1:4567/?token=abc'); setInterval(() => {}, 1000);`);
    const logFile = path.join(dir, 'run', 'web.log');
    const web = await launchDshWeb('web', { command: { file: process.execPath, args: [script] }, dshHome: dir, logFile, port: 3090 });
    try {
      expect(web.url).toBe('http://127.0.0.1:4567/?token=abc');
      expect(fs.readFileSync(logFile, 'utf8')).toContain('ready');
      expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
      // Its own process group and session: it does not stop with the terminal or process that launched it.
      expect(Number((await execa('ps', ['-o', 'pgid=', '-p', String(web.pid)])).stdout.trim())).toBe(web.pid);
      expect((await execa('ps', ['-o', 'args=', '-p', String(web.pid)])).stdout).toContain('--profile web --no-open --port 3090');

      expect(await dshWebState(web.pid, web.leaderStart)).toBe('running');
      // A process that got the pid later started at another time.
      expect(await dshWebState(web.pid, 'another start')).toBe('stopped');
    } finally {
      expect(await stopProcessGroup(web.pid)).toBe(true);
    }
    expect(await dshWebState(web.pid, web.leaderStart)).toBe('stopped');
  });
});

// Ctrl-C ends dshenv without running async cleanup, so startDshWeb must stop the detached dsh web itself.
describe('startDshWeb when dshenv is interrupted', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshenv-web-interrupt-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const interrupt = async (urlDelayMs: number, waitFor: 'pid' | 'started', ignoreTerm = false) => {
    const pidFile = path.join(dir, 'pid');
    const fake = path.join(dir, 'fake-dsh.mjs');
    fs.writeFileSync(fake, `import fs from 'node:fs';
${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setTimeout(() => console.log('dsh web: http://127.0.0.1:4567/?token=abc'), ${urlDelayMs});
setInterval(() => {}, 1000);`);
    const driver = path.join(dir, 'driver.mts');
    fs.writeFileSync(driver, `import { startDshWeb } from ${JSON.stringify(path.resolve('src/dsh/web-server.ts'))};
await startDshWeb('web', { command: { file: process.execPath, args: [${JSON.stringify(fake)}] }, dshHome: ${JSON.stringify(dir)} });
console.log('started');
setInterval(() => {}, 1000);`);
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const dshenv = execa(process.execPath, ['--import', 'tsx/esm', driver], { reject: false, env: { TMPDIR: tmp } });
    if (waitFor === 'started') {
      await new Promise<void>((resolve) => dshenv.stdout?.once('data', () => resolve()));
    } else {
      const startDeadline = Date.now() + 10_000;
      while (!fs.existsSync(pidFile) && Date.now() < startDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const dsh = Number(fs.readFileSync(pidFile, 'utf8'));
    try {
      expect(alive(dsh)).toBe(true);
      dshenv.kill('SIGINT');
      const result = await dshenv;
      expect(result.signal).toBe('SIGINT');
      const stopDeadline = Date.now() + 10_000;
      while (alive(dsh) && Date.now() < stopDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(alive(dsh)).toBe(false);
    } finally {
      // A failed check must not leave the fake dsh web or dshenv behind.
      for (const pid of [-dsh, dshenv.pid ?? 0]) {
        try {
          if (pid) process.kill(pid, 'SIGKILL');
        } catch {
          // Already stopped.
        }
      }
    }
    // Its log, which can hold the login URL, goes too.
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith('dshenv-web-'))).toEqual([]);
  };

  it('stops dsh web when interrupted while it is starting', async () => {
    await interrupt(60_000, 'pid');
  }, 30_000);

  it('stops dsh web when interrupted while the check runs', async () => {
    await interrupt(0, 'started');
  }, 30_000);

  it('kills a dsh web that ignores SIGTERM before dshenv exits', async () => {
    await interrupt(0, 'started', true);
  }, 30_000);
});
