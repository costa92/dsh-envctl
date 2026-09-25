import * as fs from 'node:fs';
import { execa } from 'execa';
import { DegradedError } from '../errors.js';

export interface CommandSpec {
  file: string;
  args: string[];
  cwd?: string;
}

export interface ResolveDshCommandInput {
  cliHarnessSource?: string;
  manifestHarnessSource?: string;
  envDshCli?: string;
  which?: (cmd: string) => string | null;
  sourceDirExists?: (dir: string) => boolean;
}

export function resolveDshCommand(input?: ResolveDshCommandInput): CommandSpec | null {
  const envDshCli = input?.envDshCli ?? process.env.DSH_CLI;
  if (envDshCli && envDshCli.trim().length > 0) {
    const trimmed = envDshCli.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === 'string')) {
          return {
            file: parsed[0],
            args: parsed.slice(1)
          };
        }
      } catch {
        // Fallback to literal execution if JSON parse fails
      }
    }
    // Literal single executable (NO shell expansion)
    return {
      file: trimmed,
      args: []
    };
  }

  const checkExists = input?.sourceDirExists ?? ((dir: string) => {
    try {
      return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });

  const sourceDir = input?.cliHarnessSource ?? input?.manifestHarnessSource;
  if (sourceDir && checkExists(sourceDir)) {
    return {
      file: 'pnpm',
      args: ['--dir', sourceDir, 'dsh'],
      cwd: sourceDir
    };
  }

  const checkWhich = input?.which ?? ((cmd: string) => {
    // In Node.js / POSIX, check if PATH has executable
    const pathDirs = (process.env.PATH || '').split(':');
    for (const dir of pathDirs) {
      const fullPath = `${dir}/${cmd}`;
      try {
        if (fs.existsSync(fullPath)) {
          return fullPath;
        }
      } catch {
        // ignore
      }
    }
    return null;
  });

  const dshPath = checkWhich('dsh');
  if (dshPath) {
    return {
      file: dshPath,
      args: []
    };
  }

  return null;
}

export interface ProbeResult {
  version: string;
  raw: string;
}

export async function probeDsh(
  cmd: CommandSpec,
  runner?: (file: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string; stderr: string }>
): Promise<ProbeResult> {
  const run = runner ?? (async (file, args, opts) => {
    return await execa(file, args, {
      ...opts,
      shell: false,
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
  });

  let res: { stdout: string; stderr: string };
  try {
    res = await run(cmd.file, [...cmd.args, '--version'], {
      cwd: cmd.cwd
    });
  } catch {
    throw new DegradedError('DSH runtime probe execution failed');
  }

  const output = (res.stdout || res.stderr || '').trim();
  // Match version like 0.1.7-rc.2 or 0.1.7
  const versionMatch = output.match(/(\d+\.\d+\.\d+(?:-[a-zA-Z0-9._-]+)?)/);
  if (!versionMatch) {
    throw new DegradedError('Unable to parse DSH runtime version');
  }

  return {
    version: versionMatch[1],
    raw: output
  };
}
