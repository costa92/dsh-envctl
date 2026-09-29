import { ValidationError } from '../errors.js';
import { scaffoldComponent } from '../scaffold/scaffold.js';
import type { ComponentKind } from '../scaffold/templates.js';
import type { PluginCommands } from './plugins.js';
import { aliasOption, profileOption, resolveCliPaths, writeLayer, WRITE_LAYER_HELP, type CommandContext } from './context.js';

export function registerNewCommand(ctx: CommandContext, plugins: PluginCommands): void {
  const { program, writeOut } = ctx;

  program
    .command('new <kind> <name>')
    .description('Create a DSH component package (skill, agent, tool or mcp) from a template')
    .option('--dir <path>', 'output directory; defaults to ./<name>')
    .option('--package <name>', 'package name; defaults to <name>')
    .option('--typescript', 'tool only: generate a TypeScript package that builds to lib/')
    .option('--loose', 'skill only: write SKILL.md into $DSH_HOME/skills without a package')
    .option('-p, --profile <name>', 'register the package in this profile, like dshenv install', profileOption)
    .option('--as <alias>', 'with -p: custom alias name', aliasOption)
    .addOption(writeLayer(`with -p: ${WRITE_LAYER_HELP}`))
    .option('--new-profile', 'with -p: allow a profile that is neither declared nor created yet')
    .action(async (kind: string, name: string, cmdOpts) => {
      const opts = program.opts();
      if (cmdOpts.loose && (cmdOpts.profile !== undefined || cmdOpts.as !== undefined || cmdOpts.layer !== undefined)) {
        throw new ValidationError('--loose cannot be combined with -p, --as or --layer');
      }
      if (cmdOpts.profile === undefined && (cmdOpts.as !== undefined || cmdOpts.layer !== undefined || cmdOpts.newProfile)) {
        throw new ValidationError('--as, --layer and --new-profile require -p');
      }

      const paths = resolveCliPaths(opts);
      const result = scaffoldComponent({
        kind: kind as ComponentKind,
        name,
        dir: cmdOpts.dir,
        packageName: cmdOpts.package,
        typescript: cmdOpts.typescript,
        loose: cmdOpts.loose,
        dshHome: paths.home,
        cwd: process.cwd()
      });

      let installed: { profile: string; alias: string } | undefined;
      if (cmdOpts.profile !== undefined) {
        try {
          const registered = await plugins.installPlugin(opts, {
            spec: result.dir,
            profile: cmdOpts.profile,
            alias: cmdOpts.as,
            packageName: result.packageName,
            layer: cmdOpts.layer,
            newProfile: cmdOpts.newProfile
          });
          installed = { profile: cmdOpts.profile, alias: registered.alias };
        } catch (err) {
          result.cleanup();
          throw err;
        }
      }

      if (opts.json) {
        writeOut(JSON.stringify({
          status: 'created',
          kind,
          dir: result.dir,
          ...(result.packageName !== undefined ? { package: result.packageName } : {}),
          files: result.files,
          ...(installed ? { installed } : {})
        }, null, 2) + '\n');
        return;
      }

      const lines = [`Created ${kind} '${name}' in ${result.dir}`, ...result.files.map((file) => `  ${file}`)];
      if (cmdOpts.typescript) {
        lines.push(`Build it first: cd ${result.dir} && pnpm install && pnpm build`);
      }
      if (installed) {
        lines.push(cmdOpts.typescript
          ? `Registered as '${installed.alias}' in profile '${installed.profile}'. Next: build, then dshenv plan and dshenv apply --yes.`
          : `Registered as '${installed.alias}' in profile '${installed.profile}'. Next: dshenv plan, then dshenv apply --yes.`);
      } else if (cmdOpts.loose) {
        lines.push('DSH picks up skills in this directory automatically.');
      } else {
        lines.push(`Next: dshenv install ${result.dir} -p <profile>`);
      }
      writeOut(lines.join('\n') + '\n');
    });
}
