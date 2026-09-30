import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { DshError, ValidationError } from './errors.js';
import { defaultTargetProfile, type CommandContext } from './commands/context.js';
import { registerSetupCommands } from './commands/setup.js';
import { registerLifecycleCommands } from './commands/lifecycle.js';
import { registerInspectCommands } from './commands/inspect.js';
import { registerPluginCommands } from './commands/plugins.js';
import { registerSourceCommands } from './commands/source.js';
import { registerOverlayCommands } from './commands/overlay.js';
import { registerNewCommand } from './commands/new.js';
import { registerRemoteCommands } from './commands/remote.js';
import { registerRuntimeCommand } from './commands/runtime.js';
import { registerWebCommands } from './commands/web.js';
import { registerSelfUpdateCommand } from './commands/self-update.js';
import { registerPullCommand } from './commands/pull.js';
import { registerToolsCommands } from './commands/tools.js';
import type { Runner } from './self-update/self-update.js';

// src/cli.ts and the bundled lib/*.js both sit one level below package.json.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

export interface CliIO {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
  // Stands in for npm and pnpm in self-update, so tests never touch the registry or the global install.
  selfUpdateRunner?: Runner;
}

// Top-level commands by task, in the order a newcomer meets them.
const HELP_GROUPS: Array<[string, string[]]> = [
  ['Getting started:', ['init', 'capture', 'adopt', 'doctor']],
  ['Everyday:', ['plan', 'apply', 'status', 'pull', 'rollback']],
  ['Plugins:', ['install', 'update', 'list', 'config', 'enable', 'disable', 'remove', 'new', 'purge']],
  ['Tools & runtime:', ['tools', 'runtime', 'web', 'mark-restarted']],
  ['Sources & team:', ['source', 'remote', 'overlay']],
  ['Maintenance:', ['gc', 'self-update']]
];

const ROOT_HELP_AFTER = `
Examples:
  dshenv init                                   start managing an empty environment
  dshenv capture -o capture.yaml && dshenv adopt -f capture.yaml --yes
                                                take over what DSH already has installed
  dshenv install @scope/plugin@1.2.3 -p web     declare a plugin in the manifest
  dshenv plan                                   review what apply would change (exit 2)
  dshenv apply --yes                            make DSH match the manifest
  dshenv web start -p web                       run dsh web in the background

Data flow:
  apply          manifest -> DSH profiles
  pull           DSH profiles -> manifest (settings changed in DSH)
  remote sync    team repository -> local envctl
  source pull    upstream Git -> a plugin's managed clone

Environment variables:
  DSH_HOME        DSH home directory (default ~/.dsh; --dsh-home wins)
  DSH_CLI         DSH command to run, e.g. a path or a JSON array
  DSHENV_PROFILE  default -p for commands that act on one profile
  DSHENV_LAYER    default --layer (base or overlay) when an overlay is active
  DSHENV_OVERLAY  overlay to use (--overlay / --no-overlay win)
  DSHENV_DSH_URL  dsh web URL that runtime checks
`;

// Aliases kept for old scripts stay out of help; the name alone is listed.
function subcommandTerm(cmd: Command): string {
  const args = cmd.registeredArguments.map((arg) => (arg.required ? `<${arg.name()}${arg.variadic ? '...' : ''}>` : `[${arg.name()}${arg.variadic ? '...' : ''}]`)).join(' ');
  return cmd.name() + (cmd.options.length ? ' [options]' : '') + (args ? ` ${args}` : '');
}

function commandUsage(cmd: Command): string {
  let ancestors = '';
  for (let parent = cmd.parent; parent; parent = parent.parent) {
    ancestors = `${parent.name()} ${ancestors}`;
  }
  return `${ancestors}${cmd.name()} ${cmd.usage()}`;
}

export async function runCli(argv: string[], io?: CliIO): Promise<number> {
  const writeOut = io?.stdout ?? ((chunk: string) => process.stdout.write(chunk));
  const writeErr = io?.stderr ?? ((chunk: string) => process.stderr.write(chunk));

  let exitCodeToReturn = 0;
  // Errors thrown before parsing leave program.opts() empty, so read argv (up to `--`) as well.
  const endOfOptions = argv.indexOf('--');
  const jsonRequested = (endOfOptions === -1 ? argv : argv.slice(0, endOfOptions)).includes('--json');

  const program = new Command();
  program
    .name('dshenv')
    .description('Environment-as-Code manager for DeepSeek Harness')
    .version(version, '-v, --version', 'output the current version')
    .option('--dsh-home <path>', 'custom DSH home directory')
    .option('--harness-source <path>', 'custom DSH source directory')
    .option('--allow-untested-dsh', 'allow untested or experimental DSH runtime versions')
    .option('--json', 'output in structured JSON format')
    .option('--overlay <name>', 'merge envctl/overlays/<name>.yaml over the base manifest for this command')
    .option('--no-overlay', 'use only the base manifest for this command')
    .configureOutput({
      writeOut: (str) => writeOut(str),
      writeErr: (str) => writeErr(str),
      // With --json the usage error is reported once, as JSON, below.
      outputError: (str, write) => {
        if (!jsonRequested) write(str);
      }
    })
    .configureHelp({ showGlobalOptions: true, subcommandTerm, commandUsage })
    .addHelpText('after', ROOT_HELP_AFTER)
    .exitOverride();

  defaultTargetProfile(program, writeErr);

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
  registerWebCommands(ctx);
  registerPullCommand(ctx);
  registerToolsCommands(ctx);
  registerSelfUpdateCommand(ctx, { version, packageRoot, run: io?.selfUpdateRunner });

  // Help lists groups, and commands within them, in the order the commands were registered.
  const order = HELP_GROUPS.flatMap(([, names]) => names);
  const rank = (cmd: Command) => (order.includes(cmd.name()) ? order.indexOf(cmd.name()) : order.length);
  (program.commands as Command[]).sort((a, b) => rank(a) - rank(b));
  for (const [heading, names] of HELP_GROUPS) {
    for (const name of names) {
      program.commands.find((cmd) => cmd.name() === name)?.helpGroup(heading);
    }
  }
  // Otherwise commander lists the help command alone under a default "Commands:" heading.
  program.commandsGroup(HELP_GROUPS[0][0]).helpCommand('help [command]', 'display help for command');

  try {
    if (argv.length === 0) {
      program.outputHelp();
      return 0;
    }
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
      if (exitCode === 0) {
        return 0;
      }
      // A usage error (missing argument, unknown option or command) is invalid input, like any other.
      if (jsonRequested) {
        const message = (err as Error).message.replace(/^error: /, '').replace(/\n/g, ' ');
        writeErr(`${JSON.stringify({ error: { type: 'ValidationError', message, exitCode: 3 } })}\n`);
      }
      return 3;
    }

    const message = err instanceof Error ? err.message : String(err);
    const exitCode = err instanceof DshError ? err.exitCode : 1;
    const json = program.opts().json === true || jsonRequested;
    if (json) {
      const type = err instanceof Error ? err.name : 'Error';
      writeErr(`${JSON.stringify({ error: { type, message, exitCode } })}\n`);
    } else {
      writeErr(`${message}\n`);
    }
    return exitCode;
  }
}
