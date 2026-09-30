import fs from 'node:fs';
import path from 'node:path';
import { run } from '../util/spawn.js';
import { SdkvmError } from '../util/errors.js';
import type { Platform } from '../core/platform.js';

const WIN_TAR = 'C:\\Windows\\System32\\tar.exe';

/** 解压预算：外部 tar/unzip/powershell 卡死（杀软扫描挂起、坏归档死循环）时，
 *  没有超时会让进程永远挂住；2GB Flutter 解压正常也就几十秒，10 分钟足够宽 */
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

/** Windows 无 tar.exe 时的 PowerShell 回退：Expand-Archive（PS5.1）不拒绝
 *  `..`/绝对路径条目，先逐条目枚举校验再解压。校验与解压同一进程完成。 */
function expandArchiveChecked(archiveFile: string, destDir: string): Promise<{ stdout: string; stderr: string }> {
  const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  // .NET 的 GetFullPath 会把 / 也当分隔符并解析 ..，条目解析回 dest 内才算安全
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${psQuote(archiveFile)})`,
    'try {',
    `  $dest = [System.IO.Path]::GetFullPath(${psQuote(destDir)})`,
    // 前缀比较必须带分隔符：`C:\...\extract-x-evil` 也会命中 `C:\...\extract-x` 的裸前缀
    "  $dest = $dest.TrimEnd('\\') + '\\'",
    '  foreach ($e in $zip.Entries) {',
    '    $p = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($dest, $e.FullName))',
    '    if (-not $p.StartsWith($dest, [System.StringComparison]::OrdinalIgnoreCase)) {',
    `      throw "unsafe archive entry: $($e.FullName)"`,
    '    }',
    '  }',
    '} finally { $zip.Dispose() }',
    `Expand-Archive -LiteralPath ${psQuote(archiveFile)} -DestinationPath ${psQuote(destDir)} -Force`,
  ].join('\n');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeoutMs: EXTRACT_TIMEOUT_MS,
  });
}

/** 解压 tar.gz / tar.xz / zip 到全新空目录（降低路径穿越面） */
export async function extractArchive(
  archiveFile: string,
  archiveType: 'tar.gz' | 'tar.xz' | 'zip',
  destDir: string,
  platform: Platform,
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });

  if (platform.os === 'windows') {
    // Win10 1803+ 自带 bsdtar（支持 zip 与 tar）；zip 解压失败（坏归档/杀软拦截）
    // 回退 Expand-Archive——tar.gz/xz 没有第二条路，失败原样上抛
    if (fs.existsSync(WIN_TAR)) {
      try {
        await run(WIN_TAR, ['-xf', archiveFile, '-C', destDir], { timeoutMs: EXTRACT_TIMEOUT_MS });
        return;
      } catch (err) {
        if (archiveType !== 'zip') throw err;
      }
    } else if (archiveType !== 'zip') {
      // Expand-Archive 只认 zip：对着 tar.gz 只会报一串难懂的 PS 错误
      throw new SdkvmError(`No tar.exe on this Windows; cannot extract ${archiveType} without it`, {
        hint: `Restore ${WIN_TAR} (Windows 10 1803+ ships it) or extract manually: ${archiveFile}`,
      });
    }
    await expandArchiveChecked(archiveFile, destDir);
    return;
  }

  if (archiveType === 'zip' && platform.rawPlatform === 'linux') {
    // Linux GNU tar 不支持 zip（正常情况下 Linux 无 zip 归档，防御性回退）
    await run('unzip', ['-q', '-o', archiveFile, '-d', destDir], { timeoutMs: EXTRACT_TIMEOUT_MS });
    return;
  }
  // macOS bsdtar / Linux GNU tar 均可 -xf 自动识别压缩格式
  await run('tar', ['-xf', archiveFile, '-C', destDir], { timeoutMs: EXTRACT_TIMEOUT_MS });
}

export function tmpExtractDir(base: string): string {
  return path.join(base, `extract-${Date.now()}-${process.pid}`);
}
