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
import { parseSha256SumLine } from '../net/checksum.js';
import { SdkvmError } from '../util/errors.js';
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
  const home = path.resolve(probe.home ?? sdkvmHome());
  const cliRoot = path.resolve(path.join(home, 'cli'));
  const runtimeRoot = path.resolve(path.join(home, 'runtime'));
  const pkg = path.resolve(probe.packageRoot ?? packageRoot());
  if (pkg === cliRoot) return true;
  const exec = path.resolve(probe.execPath ?? process.execPath);
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
  const unpacked = path.join(staging, 'package');
  if (!fs.existsSync(path.join(unpacked, 'package.json'))) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new SdkvmError('Release archive is missing package/package.json', { hint: archiveFile });
  }
  return unpacked;
}

/** 用已校验的 npm pack 归档替换 CLI 目录，不动 runtime 与已装 SDK。 */
export async function replaceCliPackage(archiveFile: string, home = sdkvmHome()): Promise<void> {
  const staging = path.join(home, 'cli.next');
  const bak = path.join(home, 'cli.bak');
  const cli = path.join(home, 'cli');
  const unpacked = await prepareCliPackage(archiveFile, home);
  fs.rmSync(bak, { recursive: true, force: true });
  if (fs.existsSync(cli)) fs.renameSync(cli, bak);
  try {
    fs.renameSync(unpacked, cli);
  } catch (err) {
    if (fs.existsSync(bak) && !fs.existsSync(cli)) {
      try {
        fs.renameSync(bak, cli);
      } catch {
        // 回滚失败时保留 bak，交给外层错误信息
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  fs.rmSync(bak, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
}

/** Windows 升级脚本正文（导出便于单测）。home 含 cmd 元字符时无法安全内插，直接拒绝 */
export function windowsUpgradeScript(home: string): string {
  if (/["%&^]/.test(home)) {
    throw new SdkvmError(`sdkvm home cannot be embedded in a Windows batch script: ${home}`, {
      hint: 'Move sdkvm to a path without \" % & ^ characters, or upgrade with: npm update -g sdkvm',
    });
  }
  return [
    '@echo off',
    'setlocal',
    `set "HOME=${home}"`,
    'timeout /t 2 /nobreak >nul',
    'if exist "%HOME%\\cli.bak" rmdir /s /q "%HOME%\\cli.bak"',
    'if exist "%HOME%\\cli" move /y "%HOME%\\cli" "%HOME%\\cli.bak" >nul',
    'move /y "%HOME%\\cli.next\\package" "%HOME%\\cli" >nul',
    'if exist "%HOME%\\cli\\package.json" (',
    '  if exist "%HOME%\\cli.bak" rmdir /s /q "%HOME%\\cli.bak"',
    '  if exist "%HOME%\\cli.next" rmdir /s /q "%HOME%\\cli.next"',
    ') else (',
    '  if exist "%HOME%\\cli.bak" if not exist "%HOME%\\cli" move /y "%HOME%\\cli.bak" "%HOME%\\cli" >nul',
    ')',
    'del "%~f0"',
    '',
  ].join('\r\n');
}

/** Windows：进程退出后再替换 cli（避免自替换 EPERM）。cli.next/package 须已就绪。 */
export function scheduleWindowsCliReplace(home: string): void {
  const script = path.join(home, 'upgrade-apply.cmd');
  fs.writeFileSync(script, windowsUpgradeScript(home), 'utf8');
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

  await withLock(async () => {
    const sumsUrl = releaseAssetUrl(RELEASE_SUMS);
    const assetUrl = releaseAssetUrl(RELEASE_ASSET);
    log.info(`checking ${assetUrl}`);
    const expected = checksumFor(await httpText(sumsUrl), RELEASE_ASSET);
    if (!expected) {
      throw new SdkvmError(`No checksum for ${RELEASE_ASSET}`, { hint: sumsUrl });
    }
    fs.mkdirSync(paths.cache(), { recursive: true });
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
      // Windows 不能可靠地替换正在运行的 CLI：先解压，退出后再由脚本换目录
      if (process.platform === 'win32') {
        await prepareCliPackage(dest, home);
        scheduleWindowsCliReplace(home);
        log.ok(
          `upgrade ${before} scheduled; exit this process and wait a moment for ${path.join(home, 'cli')} to refresh`,
        );
        return;
      }
      await replaceCliPackage(dest, home);
      const after = getVersion();
      log.ok(
        `upgraded CLI ${before} → ${after} in ${path.join(home, 'cli')}; runtime and installed SDKs were left in place`,
      );
    } finally {
      fs.rmSync(dest, { force: true });
      fs.rmSync(`${dest}.part`, { force: true });
    }
  });
}
