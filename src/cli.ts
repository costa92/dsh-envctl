import { Command } from 'commander';

export interface CliIO {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
}

export async function runCli(argv: string[], io?: CliIO): Promise<number> {
  const writeOut = io?.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = io?.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  const program = new Command();
  program
    .name('dshenv')
    .description('Environment-as-Code manager for DeepSeek Harness')
    .version('0.1.0', '-v, --version', 'output the current version')
    .option('--dsh-home <path>', 'custom DSH home directory')
    .option('--harness-source <path>', 'custom DSH source directory')
    .option('--json', 'output in structured JSON format')
    .configureOutput({
      writeOut: (str) => writeOut(str),
      writeErr: (str) => writeErr(str)
    })
    .exitOverride();

  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'exitCode' in err) {
      const exitCode = (err as { exitCode: number }).exitCode;
      return typeof exitCode === 'number' ? exitCode : 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    writeErr(`${message}\n`);
    return 1;
  }
}
