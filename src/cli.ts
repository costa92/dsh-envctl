import { Command } from 'commander';
import { DshError } from './errors.js';
import type { CommandContext } from './commands/context.js';
import { registerSetupCommands } from './commands/setup.js';
import { registerLifecycleCommands } from './commands/lifecycle.js';
import { registerInspectCommands } from './commands/inspect.js';
import { registerPluginCommands } from './commands/plugins.js';
import { registerSourceCommands } from './commands/source.js';

export interface CliIO {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

export async function runCli(argv: string[], io?: CliIO): Promise<number> {
  const writeOut = io?.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = io?.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  let exitCodeToReturn = 0;

  const program = new Command();
  program
    .name('dshenv')
    .description('Environment-as-Code manager for DeepSeek Harness')
    .version('0.1.0', '-v, --version', 'output the current version')
    .option('--dsh-home <path>', 'custom DSH home directory')
    .option('--harness-source <path>', 'custom DSH source directory')
    .option('--allow-untested-dsh', 'allow untested or experimental DSH runtime versions')
    .option('--json', 'output in structured JSON format')
    .configureOutput({
      writeOut: (str) => writeOut(str),
      writeErr: (str) => writeErr(str)
    })
    .exitOverride();

  const ctx: CommandContext = {
    program,
    writeOut,
    setExitCode: (code) => {
      exitCodeToReturn = code;
    }
  };
  registerSetupCommands(ctx);
  registerLifecycleCommands(ctx);
  registerInspectCommands(ctx);
  registerPluginCommands(ctx);
  registerSourceCommands(ctx);

  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCodeToReturn;
  } catch (err: unknown) {
    const isCommanderError = err && typeof err === 'object' && (err as { code?: string }).code?.startsWith('commander.');
    if (isCommanderError) {
      const exitCode = (err as { exitCode?: number }).exitCode;
      return typeof exitCode === 'number' ? exitCode : 1;
    }

    const message = err instanceof Error ? err.message : String(err);
    writeErr(`${message}\n`);
    if (err instanceof DshError) {
      return err.exitCode;
    }
    return 1;
  }
}
