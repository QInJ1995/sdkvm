import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SdkvmError } from '../util/errors.js';

export interface SilentInstallCommand {
  cmd: string;
  args: string[];
}

/**
 * 官方静默参数。Unix：`bash <file> -b -p <prefix>`（不改 rc，视为接受条款）。
 * Windows：`/D` 必须放最后且不加引号；不改 PATH、不注册 Python。
 */
export function silentInstallCommand(
  installerFile: string,
  archive: 'sh' | 'exe',
  prefix: string,
): SilentInstallCommand {
  if (archive === 'sh') {
    return { cmd: 'bash', args: [installerFile, '-b', '-p', prefix] };
  }
  return {
    cmd: installerFile,
    args: ['/InstallationType=JustMe', '/AddToPath=0', '/RegisterPython=0', '/S', `/D=${prefix}`],
  };
}

/** Windows 安装器的 /D 路径不能含空格。其它平台不限制。 */
export function assertInstallerPrefix(prefix: string, os: 'mac' | 'linux' | 'windows'): void {
  if (os === 'windows' && /\s/.test(prefix)) {
    throw new SdkvmError(`Miniconda cannot install to a path that contains spaces: ${prefix}`, {
      hint: 'Set SDKVM_HOME to a path without spaces and retry.',
    });
  }
}

/**
 * 把安装器装进 prefix。prefix 必须是最终路径：安装器会把该路径写进 shebang 和 conda-meta，
 * 装完再移动目录会让 conda 失效。调用前目录不能存在，由调用方决定是否先挪走旧安装。
 */
export async function runSilentInstaller(
  installerFile: string,
  archive: 'sh' | 'exe',
  prefix: string,
  os: 'mac' | 'linux' | 'windows',
): Promise<void> {
  assertInstallerPrefix(prefix, os);
  if (fs.existsSync(prefix)) {
    throw new SdkvmError(`Install prefix already exists: ${prefix}`, {
      hint: 'Remove it or re-run install with --force.',
    });
  }
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  const { cmd, args } = silentInstallCommand(installerFile, archive, prefix);
  await runInherit(cmd, args);
}

/** 安装器输出直接打到终端，避免把约 1 GB 解压日志塞进 maxBuffer。
 *  安装器卡死（等待 stdin、杀软挂起）没有超时会一直持锁——分钟级大安装器给足 20 分钟。 */
const INSTALLER_TIMEOUT_MS = 20 * 60 * 1000;

function runInherit(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new SdkvmError(message, { hint: `args: ${args.join(' ')}` }));
    };
    const child = spawn(cmd, args, { stdio: 'inherit', windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, INSTALLER_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(`Failed to run ${cmd}: ${err.message}`);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else if (timedOut) {
        fail(`Installer ${cmd} timed out after ${Math.round(INSTALLER_TIMEOUT_MS / 60000)} min`);
      } else fail(`Failed to run ${cmd}: exit ${code ?? 'unknown'}`);
    });
  });
}
