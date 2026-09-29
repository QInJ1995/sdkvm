#!/usr/bin/env node
import { Command } from 'commander';
import { toSdkvmError } from './util/errors.js';
import { log } from './ui/log.js';
import { installCommand } from './cli/install.js';
import { useCommand } from './cli/use.js';
import { lsCommand, currentCommand } from './cli/ls.js';
import { uninstallCommand } from './cli/uninstall.js';
import { mirrorCommand } from './cli/mirror.js';
import { getVersion, versionCommand } from './cli/misc.js';
import { upgradeCommand } from './cli/upgrade.js';
import { nrmLs, nrmUse, nrmCurrent, nrmAdd, nrmDel, nrmTest } from './cli/nrm.js';
import { mrmAdd, mrmCurrent, mrmDel, mrmLs, mrmSettings, mrmTest, mrmUse } from './cli/mrm.js';
import { getSdkType } from './sdk/index.js';
import type { SdkTypeId } from './sdk/types.js';

const program = new Command();

program
  .name('sdkvm')
  .description('SDK version manager — install & switch JDKs (Temurin / Zulu / Corretto), Go toolchains, Flutter SDKs, Node.js runtimes, Apache Maven, Miniconda, and CPython')
  .version(getVersion());

const INSTALL_HELP: Record<SdkTypeId, string> = {
  java: '21 | lts | 21.0.5 | 21.0.5+11 | temurin-21',
  go: '1.24 | 1.24.5 | latest | golang-1.24',
  flutter: '3.47 | 3.47.5 | 3.49.0-0.1.pre | latest | flutter-3.47',
  node: '22 | 22.20.0 | lts | latest | nodejs-22.20.0',
  maven: '3 | 3.9 | 3.9.9 | 4.0.0-rc-4 | latest | maven-3.9',
  miniconda: '26 | 26.7 | 26.7.1-1 | py313 | py313_26.7.1-1 | latest',
  python: '3 | 3.12 | 3.12.7 | 3.14.0rc2 | latest',
};

const VERSION_EXAMPLE: Record<SdkTypeId, string> = {
  java: '21 / temurin-21.0.5+11',
  go: '1.24 / golang-1.24.5',
  flutter: '3.47 / flutter-3.47.5',
  node: '22 / nodejs-22.20.0',
  maven: '3.9 / maven-3.9.9',
  miniconda: '26.7 / miniconda-py313_26.7.1-1',
  python: '3.12 / cpython-3.12.7',
};

/** 某类型的一组命令（install/use/ls/uninstall/mirror）挂到给定 commander 节点上 */
function registerSdkCommands(cmd: Command, type: SdkTypeId): void {
  const s = getSdkType(type);
  const vendorIds = s.vendors.map((v) => v.id).join(' | ');

  cmd
    .command('install')
    .description(`install a ${s.label}: ${INSTALL_HELP[type]}`)
    .argument('<version>', 'version spec (optional vendor- prefix)')
    .option('--vendor <id>', `vendor: ${vendorIds}`)
    .option('--force', 'reinstall even if already installed')
    .action((v: string, o: { vendor?: string; force?: boolean }) => installCommand(type, v, o));

  cmd
    .command('use')
    .description(`switch the current ${s.label} (updates ${s.envVar} / PATH)`)
    .argument('<version>', `installed version, e.g. ${VERSION_EXAMPLE[type]}`)
    .option('--vendor <id>', 'restrict matching to a vendor')
    .action((v: string, o: { vendor?: string }) => useCommand(type, v, o));

  cmd
    .command('ls')
    .alias('list')
    .description(`list installed ${s.label}s (→ marks current); -r lists installable versions`)
    .option('-r, --remote', 'list installable versions from all vendors')
    .option('--vendor <id>', 'filter --remote output to one vendor')
    .action((o: { remote?: boolean; vendor?: string }) => lsCommand(type, o));

  cmd
    .command('current')
    .description(
      // 裸命令（java）的 current 被重绑为显示全部类型（见下方 currentCommand()）
      `show the current ${s.label}${type === 'java' ? 's (bare "sdkvm current" lists every SDK type)' : ''}`,
    )
    .action(() => currentCommand([type]));

  cmd
    .command('uninstall')
    .description(`remove an installed ${s.label}`)
    .argument('<version>', `installed version, e.g. ${VERSION_EXAMPLE[type]}`)
    .option('--vendor <id>', 'restrict matching to a vendor')
    .action((v: string, o: { vendor?: string }) => uninstallCommand(type, v, o));

  cmd
    .command('mirror')
    .description('show, set, or switch download mirror sites for this SDK')
    .argument('[action]', 'ls | use | current | show | set | unset')
    .argument('[nameOrVendor]', 'site name, vendor id, or URL')
    .argument('[url]', 'mirror root URL (for set)')
    .action((a: string | undefined, v: string | undefined, u: string | undefined) =>
      mirrorCommand(type, a, v, u),
    );
}

// 裸命令 = java（历史行为，向后兼容）
registerSdkCommands(program, 'java');

// java / go / flutter / node / maven 子命令组
const javaCmd = program.command('java').description('Java (JDK) subcommands (same as the bare commands)');
registerSdkCommands(javaCmd, 'java');
javaCmd.action(() => javaCmd.help());

const goCmd = program.command('go').description('Go toolchain subcommands');
registerSdkCommands(goCmd, 'go');
goCmd.action(() => goCmd.help());

const flutterCmd = program.command('flutter').description('Flutter SDK subcommands');
registerSdkCommands(flutterCmd, 'flutter');
flutterCmd.action(() => flutterCmd.help());

const nodeCmd = program.command('node').description('Node.js subcommands');
registerSdkCommands(nodeCmd, 'node');
nodeCmd.action(() => nodeCmd.help());

const mavenCmd = program.command('maven').description('Apache Maven subcommands');
registerSdkCommands(mavenCmd, 'maven');
mavenCmd.action(() => mavenCmd.help());

const minicondaCmd = program.command('miniconda').description('Miniconda subcommands');
registerSdkCommands(minicondaCmd, 'miniconda');
minicondaCmd.action(() => minicondaCmd.help());

const pythonCmd = program.command('python').description('CPython subcommands');
registerSdkCommands(pythonCmd, 'python');
pythonCmd.action(() => pythonCmd.help());

// 裸 current 显示全部类型
program.commands.find((c) => c.name() === 'current')?.action(() => currentCommand());

program
  .command('version')
  .description('print sdkvm CLI version')
  .action(versionCommand);

program
  .command('upgrade')
  .description('upgrade the sdkvm CLI (script install replaces ~/.sdkvm/cli; npm install prints npm update -g)')
  .action(upgradeCommand);

const nrmCmd = program.command('nrm').description('npm registry manager (like nrm)');
nrmCmd
  .command('ls')
  .alias('list')
  .description('list npm registries (* marks current)')
  .action(() => nrmLs());
nrmCmd
  .command('current')
  .description('print the current npm registry')
  .action(() => nrmCurrent());
nrmCmd
  .command('use')
  .description('switch the user-level npm registry')
  .argument('<name>', 'registry name, e.g. npm / taobao / myprivate')
  .action((name: string) => nrmUse(name));
nrmCmd
  .command('add')
  .description('add a custom npm registry')
  .argument('<name>', 'registry name')
  .argument('<url>', 'registry URL')
  .action((name: string, url: string) => nrmAdd(name, url));
nrmCmd
  .command('del')
  .alias('delete')
  .alias('rm')
  .description('delete a custom npm registry')
  .argument('<name>', 'custom registry name')
  .action((name: string) => nrmDel(name));
nrmCmd
  .command('test')
  .description('ping registries and print latency')
  .argument('[name]', 'optional registry name; omit to test all')
  .action((name: string | undefined) => nrmTest(name));
nrmCmd.action(() => nrmCmd.help());

const mrmCmd = program
  .command('mrm')
  .description('Maven dependency mirror manager (settings.xml, like nrm)')
  .option('--settings <path>', 'settings.xml for this invocation (not saved)');

function mrmFlag(cmd: Command): string | undefined {
  const settings = cmd.optsWithGlobals().settings as string | undefined;
  return settings?.trim() || undefined;
}

mrmCmd
  .command('ls')
  .alias('list')
  .description('list Maven repository mirrors (* marks current)')
  .action(function (this: Command) {
    mrmLs({ settings: mrmFlag(this) });
  });
mrmCmd
  .command('current')
  .description('print the current Maven repository mirror')
  .action(function (this: Command) {
    mrmCurrent({ settings: mrmFlag(this) });
  });
mrmCmd
  .command('use')
  .description('switch the Maven repository mirror in settings.xml')
  .argument('<name>', 'registry name, e.g. official / aliyun / myrepo')
  .action(function (this: Command, name: string) {
    mrmUse(name, { settings: mrmFlag(this) });
  });
mrmCmd
  .command('add')
  .description('add a custom Maven repository mirror')
  .argument('<name>', 'registry name')
  .argument('<url>', 'repository root URL')
  .action((name: string, url: string) => mrmAdd(name, url));
mrmCmd
  .command('del')
  .alias('delete')
  .alias('rm')
  .description('delete a custom Maven repository mirror')
  .argument('<name>', 'custom registry name')
  .action((name: string) => mrmDel(name));
mrmCmd
  .command('test')
  .description('GET a known POM from each repository and print latency')
  .argument('[name]', 'optional registry name; omit to test all')
  .action(function (this: Command, name: string | undefined) {
    return mrmTest(name, { settings: mrmFlag(this) });
  });
mrmCmd
  .command('settings')
  .description('show, set, or clear the settings.xml path (path | unset)')
  .argument('[path]', 'absolute or ~/ path to save, or unset')
  .action(function (this: Command, p: string | undefined) {
    mrmSettings(p, { settings: mrmFlag(this) });
  });
mrmCmd.action(() => mrmCmd.help());

program.parseAsync(process.argv).catch((err: unknown) => {
  const e = toSdkvmError(err);
  log.error(e.message);
  if (e.hint) log.info(e.hint);
  process.exitCode = e.exitCode;
});
