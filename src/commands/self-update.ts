import { selfUpdate, type Runner } from '../self-update/self-update.js';
import type { CommandContext } from './context.js';

export interface SelfUpdateCommandInput {
  version: string;
  packageRoot: string;
  run?: Runner;
}

export function registerSelfUpdateCommand(ctx: CommandContext, input: SelfUpdateCommandInput): void {
  const { program, writeOut, setExitCode } = ctx;

  program
    .command('self-update')
    .description('Update dshenv itself from the npm registry with the package manager that installed it')
    .option('--check', 'only report whether a newer version exists; exit code 2 when one does')
    .option('--to <version>', 'install this exact version instead of the latest')
    .action(async (cmdOpts: { check?: boolean; to?: string }) => {
      const opts = program.opts();
      const result = await selfUpdate({
        currentVersion: input.version,
        packageRoot: input.packageRoot,
        to: cmdOpts.to,
        check: cmdOpts.check,
        run: input.run
      });
      if (result.status === 'available') {
        setExitCode(2);
      }
      if (opts.json) {
        writeOut(JSON.stringify(result, null, 2) + '\n');
        return;
      }
      if (result.status === 'up-to-date') {
        writeOut(`dshenv ${result.current} is up to date\n`);
      } else if (result.status === 'available') {
        writeOut(`dshenv ${result.target} is available (installed ${result.current}); run: dshenv self-update${cmdOpts.to ? ` --to ${result.target}` : ''}\n`);
      } else {
        writeOut(`Updated dshenv ${result.current} -> ${result.target} with: ${result.command}\n`);
      }
    });
}
