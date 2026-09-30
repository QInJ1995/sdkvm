import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { SdkvmError } from './errors.js';

const execFileAsync = promisify(execFile);

export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: unknown; killed?: boolean };
    // 超时被 kill 的进程没有 stderr，只有含糊的 spawn ETIMEDOUT/终止消息
    if (e.killed && opts.timeoutMs) {
      throw new SdkvmError(`Failed to run ${cmd}: timed out after ${Math.round(opts.timeoutMs / 1000)}s`, {
        hint: `args: ${args.join(' ')}`,
      });
    }
    const detail = (e.stderr || e.message || '').split('\n')[0];
    throw new SdkvmError(`Failed to run ${cmd}: ${detail}`, {
      hint: `args: ${args.join(' ')}`,
      // 保留原始错误：execFile 的失败有两种——errno 字符串 code（spawn 层，
      // 找不到/无权执行）与数字 code（进程自身非零退出），调用方靠它区分
      cause: err,
    });
  }
}

/** node 自带 npm 的 cli 入口（与 node 可执行文件同树的 node_modules/npm/bin/npm-cli.js） */
export function npmCliPath(execPath: string): string {
  return path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/**
 * npm 的无 shell 调用方式。Windows 上 npm 是 npm.cmd，execFile 无法直接启动；
 * 借运行中的 node 执行 npm-cli.js，不经 shell、参数走数组，无注入面。
 */
export function npmExec(): { cmd: string; prefixArgs: string[] } {
  if (process.platform !== 'win32') return { cmd: 'npm', prefixArgs: [] };
  const cli = npmCliPath(process.execPath);
  if (!fs.existsSync(cli)) {
    throw new SdkvmError('npm is not available', {
      hint: `Cannot find npm-cli.js next to node: ${cli}. Install Node.js with npm, or run: sdkvm node use lts`,
    });
  }
  return { cmd: process.execPath, prefixArgs: [cli] };
}
