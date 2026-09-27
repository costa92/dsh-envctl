import { Command } from 'commander';
import { DshError, ValidationError } from './errors.js';
import type { CommandContext } from './commands/context.js';
import { registerSetupCommands } from './commands/setup.js';
import { registerLifecycleCommands } from './commands/lifecycle.js';
import { registerInspectCommands } from './commands/inspect.js';
import { registerPluginCommands } from './commands/plugins.js';
import { registerSourceCommands } from './commands/source.js';
import { registerOverlayCommands } from './commands/overlay.js';
import { registerNewCommand } from './commands/new.js';
import { registerRemoteCommands } from './commands/remote.js';
import { registerRuntimeCommand } from './commands/runtime.js';

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
    .option('--overlay <name>', 'merge envctl/overlays/<name>.yaml over the base manifest for this command')
    .option('--no-overlay', 'use only the base manifest for this command')
    .configureOutput({
      writeOut: (str) => writeOut(str),
      writeErr: (str) => writeErr(str)
    })
    .exitOverride();

  const ctx: CommandContext = {
    program,
    writeOut,
    writeErr,
    setExitCode: (code) => {
      exitCodeToReturn = code;
    }
  };
  registerSetupCommands(ctx);
  registerLifecycleCommands(ctx);
  registerInspectCommands(ctx);
  const plugins = registerPluginCommands(ctx);
  registerSourceCommands(ctx);
  registerOverlayCommands(ctx);
  registerNewCommand(ctx, plugins);
  registerRemoteCommands(ctx);
  registerRuntimeCommand(ctx);

  try {
    // commander keeps only the last of the two flags, so a conflict must be detected on argv.
    if (argv.includes('--no-overlay') && argv.some((arg) => arg === '--overlay' || arg.startsWith('--overlay='))) {
      throw new ValidationError('--overlay and --no-overlay cannot be used together');
    }
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
