import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLock } from '../core/lock.js';
import { paths, sdkvmHome } from '../core/paths.js';
import { detectPlatform } from '../core/platform.js';
import { downloadFile } from '../net/download.js';
import { httpText } from '../net/http.js';
import { extractArchive } from '../fs/extract.js';
import { assertContained } from '../fs/layout.js';
import { parseSha256SumLine } from '../net/checksum.js';
import { sweepStaleParts } from './install.js';
import { SdkvmError } from '../util/errors.js';
import { renameWithRetry } from '../util/rename.js';
import { log } from '../ui/log.js';
import { getVersion } from './misc.js';

export const RELEASE_REPO = 'QInJ1995/sdkvm';
export const RELEASE_ASSET = 'sdkvm.tgz';
export const RELEASE_SUMS = 'SHA256SUMS';

/** 当前进程加载的 CLI 包根（dist/index.js 的上一级）。 */
export function packageRoot(metaUrl = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), '..');
}

export interface ScriptInstallProbe {
  home?: string;
  /** 覆盖 import.meta 解析出的包根（测试用） */
  packageRoot?: string;
  /** 覆盖 process.execPath（测试用） */
  execPath?: string;
}

/**
 * 按「当前进程如何启动」判断是否为脚本安装。
 * 包根位于 home/cli，或 node 可执行文件位于 home/runtime，即视为脚本安装。
 * 不单靠磁盘上有没有 cli/ 目录，避免混装时走错升级分支。
 */
export function isScriptInstall(probe: ScriptInstallProbe = {}): boolean {
  // realpath 归一：SDKVM_HOME 走 /tmp 这类符号链接时（macOS /tmp → /private/tmp），
  // 链接拼写与 import.meta/execPath 解出的真实路径不一致，脚本安装会被误判成 npm 安装。
  // 尚不存在的路径回溯到最长存在的祖先再 realpath，保证两侧拼写归一方式一致
  const real = (p: string): string => {
    const abs = path.resolve(p);
    let cur = abs;
    const tail: string[] = [];
    for (;;) {
      try {
        const rp = fs.realpathSync(cur);
        return tail.length > 0 ? path.join(rp, ...tail) : rp;
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return abs; // 一路到根都不存在
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  };
  const home = real(probe.home ?? sdkvmHome());
  const cliRoot = real(path.join(home, 'cli'));
  const runtimeRoot = real(path.join(home, 'runtime'));
  const pkg = real(probe.packageRoot ?? packageRoot());
  if (pkg === cliRoot) return true;
  const exec = real(probe.execPath ?? process.execPath);
  return exec === runtimeRoot || exec.startsWith(runtimeRoot + path.sep);
}

export function releaseBase(): string {
  const fromEnv = process.env.SDKVM_RELEASE_BASE?.replace(/\/+$/, '');
  return fromEnv || `https://github.com/${RELEASE_REPO}/releases`;
}

export function releaseAssetUrl(name: string, base = releaseBase()): string {
  return `${base}/latest/download/${name}`;
}

/** 从 `sha256sum` 输出里取出某个文件名的摘要。 */
export function checksumFor(sumsText: string, fileName: string): string | null {
  for (const line of sumsText.split('\n')) {
    const row = parseSha256SumLine(line);
    if (row?.name === fileName) return row.hash;
  }
  return null;
}

/** 解压并校验归档，返回 package 目录路径（位于 home/cli.next/package）。 */
export async function prepareCliPackage(archiveFile: string, home = sdkvmHome()): Promise<string> {
  const staging = path.join(home, 'cli.next');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  await extractArchive(archiveFile, 'tar.gz', staging, detectPlatform());
  // 与安装路径同款收尾审计：外部 tar 对 `..`/符号链接的处理因实现而异，
  // 条目不得逃逸 staging、符号链接不得外指
  assertContained(staging, staging);
  const unpacked = path.join(staging, 'package');
  if (!fs.existsSync(path.join(unpacked, 'package.json'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new SdkvmError('Release archive is missing package/package.json', { hint: archiveFile });
  }
  return unpacked;
}

/** 用已校验的 npm pack 归档替换 CLI 目录，不动 runtime 与已装 SDK。 */
export async function replaceCliPackage(archiveFile: string, home = sdkvmHome()): Promise<void> {
  const unpacked = await prepareCliPackage(archiveFile, home);
  await swapCliPackage(unpacked, home);
}

/** 把 cli.next/package 换位成 cli（失败时回滚 bak）。unpacked 须已通过校验。 */
async function swapCliPackage(unpacked: string, home: string): Promise<void> {
  const staging = path.join(home, 'cli.next');
  const bak = path.join(home, 'cli.bak');
  const cli = path.join(home, 'cli');
  try {
    fs.rmSync(bak, { recursive: true, force: true });
  } catch (err) {
    // 旧 bak 清不掉（杀软锁住）：继续换位会把旧 cli move 进残留 bak 形成嵌套坏布局
    throw new SdkvmError(`cannot clear the stale ${bak}: ${(err as Error).message}`, {
      hint: 'Usually a transient antivirus/indexer lock. Retry in a moment; cli.next was left for the retry.',
    });
  }
  if (fs.existsSync(cli)) await renameWithRetry(cli, bak);
  try {
    await renameWithRetry(unpacked, cli);
  } catch (err) {
    if (fs.existsSync(bak) && !fs.existsSync(cli)) {
      try {
        await renameWithRetry(bak, cli);
      } catch {
        // 回滚失败时保留 bak，交给外层错误信息
      }
    }
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // 残留无害：下次升级 prepareCliPackage 会先清
    }
    throw err;
  }
  try {
    fs.rmSync(bak, { recursive: true, force: true });
  } catch (err) {
    log.warn(`could not remove the old CLI backup ${bak}: ${(err as Error).message}`);
  }
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch {
    // 残留无害：下次升级 prepareCliPackage 会先清
  }
}

/** 读 cli.next/package 里解压出的版本号（读不到返回 null，调用方跳过短路判断） */
function stagedVersion(unpacked: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(unpacked, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/** Windows 升级脚本正文（导出便于单测）。
 *  HOME 由 %~dp0 推导而非内嵌：脚本写在 sdkvm 根目录，路径含中文/空格/cmd 元字符都能工作，
 *  也不再把合法路径误判成"无法嵌入"而拒绝升级。 */
export function windowsUpgradeScript(): string {
  return [
    '@echo off',
    'setlocal',
    'rem HOME 从脚本位置推导（脚本就放在 sdkvm 根目录）',
    'for %%i in ("%~dp0.") do set "HOME=%%~fi"',
    'rem 等本进程退出。ping 在 stdin 被重定向时也能当 sleep 用；timeout 命令会立刻报错',
    'ping -n 3 127.0.0.1 >nul',
    // 旧 bak 清不掉就中止：move /y 到已存在的目录会把 cli 嵌套进 bak（cmd 语义），
    // 产出 cli.bak\\cli\\... 的坏布局。cli.next 保留，重试时脚本会重来
    'if not exist "%HOME%\\cli.bak" goto :nobak',
    'rmdir /s /q "%HOME%\\cli.bak"',
    'if exist "%HOME%\\cli.bak" (',
    '  echo sdkvm: cannot clear stale cli.bak (antivirus lock?); upgrade aborted 1>&2',
    '  echo rollbackfail>"%HOME%\\upgrade-apply.status"',
    '  exit /b 1',
    ')',
    ':nobak',
    'set "MOVED=0"',
    'set "SWAP=0"',
    'if not exist "%HOME%\\cli" goto :swap',
    'move /y "%HOME%\\cli" "%HOME%\\cli.bak" >nul && set "MOVED=1"',
    'if "%MOVED%"=="0" (',
    '  rem 杀软/索引器可能短暂锁住目录：等 1 秒重试一次',
    '  ping -n 2 127.0.0.1 >nul',
    '  move /y "%HOME%\\cli" "%HOME%\\cli.bak" >nul && set "MOVED=1"',
    ')',
    // 第一步失败时 cli 仍在原位：绝不能把 cli.next\\package move 进现存的 cli
    // （move /y 目标为目录时会嵌套进去，污染旧安装）
    'if "%MOVED%"=="0" goto :rollback',
    'if exist "%HOME%\\cli" goto :rollback',
    ':swap',
    'set "SWAP=1"',
    'move /y "%HOME%\\cli.next\\package" "%HOME%\\cli" >nul || goto :rollback',
    'if not exist "%HOME%\\cli\\package.json" goto :rollback',
    'if exist "%HOME%\\cli.bak" rmdir /s /q "%HOME%\\cli.bak"',
    'if exist "%HOME%\\cli.next" rmdir /s /q "%HOME%\\cli.next"',
    'echo ok>"%HOME%\\upgrade-apply.status"',
    'del "%~f0"',
    'exit /b 0',
    // 回滚只在存在 bak 时清掉 cli：bak 不在且换位未开始，cli 是完好的旧版本；
    // 已进入换位且 cli 缺 package.json 的，是刚换上的坏新 cli，清掉别留任。
    // cli.next（已验 SHA256 的载荷）保留给重试，回滚不再销毁它
    ':rollback',
    'if exist "%HOME%\\cli.bak" (',
    '  if exist "%HOME%\\cli" rmdir /s /q "%HOME%\\cli"',
    '  move /y "%HOME%\\cli.bak" "%HOME%\\cli" >nul || goto :rollbackfail',
    ') else if "%SWAP%"=="1" if exist "%HOME%\\cli" if not exist "%HOME%\\cli\\package.json" (',
    '  rmdir /s /q "%HOME%\\cli"',
    ')',
    'echo rollback>"%HOME%\\upgrade-apply.status"',
    'del "%~f0"',
    'exit /b 1',
    // 回滚的 move 也失败：保留 bak 给用户手工换回，脚本留在盘上（不再自删）以便重试
    ':rollbackfail',
    'echo sdkvm: upgrade rollback failed; kept "%HOME%\\cli.bak" - rename it to cli manually 1>&2',
    'echo rollbackfail>"%HOME%\\upgrade-apply.status"',
    'exit /b 2',
    '',
  ].join('\r\n');
}

/** Windows：进程退出后再替换 cli（避免自替换 EPERM）。cli.next/package 须已就绪。 */
export function scheduleWindowsCliReplace(home: string): void {
  const script = path.join(home, 'upgrade-apply.cmd');
  fs.writeFileSync(script, windowsUpgradeScript(), 'utf8');
  const child = spawn('cmd.exe', ['/c', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  // detached spawn 异步 emit 'error'（EMFILE 等）无监听会变成 uncaughtException
  child.on('error', (err) => {
    log.warn(`could not schedule the upgrade script: ${err.message}`);
    log.warn(`run it manually: ${script}`);
  });
  child.unref();
}

export async function upgradeCommand(): Promise<void> {
  if (!isScriptInstall()) {
    log.info('this install came from npm; upgrade with: npm update -g sdkvm');
    log.info('or: pnpm update -g sdkvm / yarn global upgrade sdkvm / bun update -g sdkvm');
    return;
  }

  // 上一次"计划式升级"（Windows）的结局写在本文件里：脚本退出码没人收，
  // 不读它的话失败完全无声，用户只看到版本没变。读一次即焚，本次升级即重试
  const statusFile = path.join(sdkvmHome(), 'upgrade-apply.status');
  try {
    const prev = fs.readFileSync(statusFile, 'utf8').trim();
    fs.rmSync(statusFile, { force: true });
    if (prev === 'rollback' || prev === 'rollbackfail') {
      log.warn('the previous scheduled upgrade did not complete (it rolled back); retrying it now');
    }
  } catch {
    // 无状态文件：上次升级成功或从未计划过
  }

  await withLock(async () => {
    const sumsUrl = releaseAssetUrl(RELEASE_SUMS);
    const assetUrl = releaseAssetUrl(RELEASE_ASSET);
    log.info(`checking ${assetUrl}`);
    const expected = checksumFor(await httpText(sumsUrl), RELEASE_ASSET);
    if (!expected) {
      throw new SdkvmError(`No checksum for ${RELEASE_ASSET}`, { hint: sumsUrl });
    }
    fs.mkdirSync(paths.cache(), { recursive: true });
    // 顺手清掉历史下载残留（kill -9 留下的 .part 永远不会再被复用）
    sweepStaleParts();
    const dest = path.join(paths.cache(), RELEASE_ASSET);
    try {
      const downloaded = await downloadFile(assetUrl, dest);
      if (downloaded.sha256 !== expected) {
        throw new SdkvmError(`Checksum mismatch for ${RELEASE_ASSET}`, {
          hint: `expected ${expected}, got ${downloaded.sha256}`,
        });
      }
      const before = getVersion();
      const home = sdkvmHome();
      // 统一先解压到 cli.next 并读出新版本：相同版本直接收工，不再空换一轮目录
      // （Windows 还省掉一次"计划升级"的误导提示）
      const staged = await prepareCliPackage(dest, home);
      const next = stagedVersion(staged);
      if (next === before) {
        fs.rmSync(path.join(home, 'cli.next'), { recursive: true, force: true });
        log.ok(`already up to date (${before})`);
        return;
      }
      // Windows 不能可靠地替换正在运行的 CLI：退出后再由脚本换目录
      if (process.platform === 'win32') {
        scheduleWindowsCliReplace(home);
        log.ok(
          `upgrade ${before} scheduled; exit this process and wait a moment for ${path.join(home, 'cli')} to refresh`,
        );
        return;
      }
      await swapCliPackage(staged, home);
      const after = getVersion();
      log.ok(
        `upgraded CLI ${before} → ${after} in ${path.join(home, 'cli')}; runtime and installed SDKs were left in place`,
      );
    } finally {
      // swap 已完成时缓存删除失败绝不能把成功升级报成失败；下载/校验失败时也只
      // 降级为警告，不覆盖原始错误（install.ts 的 finally 同款语义）
      try {
        fs.rmSync(dest, { force: true });
      } catch (err) {
        log.warn(`could not remove the downloaded cache file ${dest}: ${(err as Error).message}`);
      }
    }
  });
}
