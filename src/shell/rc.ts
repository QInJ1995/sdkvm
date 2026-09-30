import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../core/paths.js';
import { detectPlatform } from '../core/platform.js';
import { getSdkType } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';
import { CLI_BIN } from '../cli/cmdname.js';
import { log } from '../ui/log.js';

export function rcBegin(type: SdkTypeId): string {
  return `# >>> ${CLI_BIN} ${type} init >>>`;
}

export function rcEnd(type: SdkTypeId): string {
  return `# <<< ${CLI_BIN} ${type} init <<<`;
}

/** 标记块内容：环境变量指向该类型的 current 链接；case 守卫防 PATH 重复叠加 */
export function rcBlock(type: SdkTypeId): string {
  const spec = getSdkType(type);
  // envBinSuffix 在 Windows 为注册表 PATH 用的 \\bin 形式；rc 是 shell 脚本，统一归一为 /
  const binSuffix = spec.envBinSuffix(detectPlatform()).replace(/\\/g, '/');
  const abs = paths.current(type);
  const rel = path.relative(os.homedir(), abs);
  // rc 是 shell 脚本，分隔符永远用 /（Windows 上 path.relative 会给出 \）
  const toPosix = (p: string) => p.split(path.sep).join('/');
  // 根目录在 home 之外（SDKVM_HOME 自定义，或跨盘导致 path.relative 返回绝对路径）时退回绝对 posix 路径
  const fallbackAbs = rel.startsWith('..') || path.isAbsolute(rel);
  // 路径含 " / ` / $ / ! / \ 时改用单引号字面量。
  // 双引号挡不住交互 shell 的 history expansion（!）和反斜杠转义；
  // 此时也不用 $HOME/ 相对形式（单引号会关掉展开）
  const needsLiteral = /["'`$!\\]/.test(abs);
  const link = needsLiteral
    ? `'${toPosix(abs).replace(/'/g, `'\\''`)}'`
    : fallbackAbs
      ? toPosix(abs)
      : `$HOME/${toPosix(rel)}`;
  // needsLiteral 时 link 自带单引号，外层不能再套双引号（否则引号进值、$ 仍展开）
  const homeLine = needsLiteral
    ? `export ${spec.envVar}=${link}`
    : `export ${spec.envVar}="${link}"`;
  const extra = spec.rcExtra?.(spec.envVar);
  return [
    rcBegin(type),
    homeLine,
    `case ":$PATH:" in *":$${spec.envVar}${binSuffix}:"*) ;; *) export PATH="$${spec.envVar}${binSuffix}:$PATH";; esac`,
    ...(extra ? [extra] : []),
    rcEnd(type),
  ].join('\n');
}

/** 标记块内容（fish 语法）：set -gx + fish_add_path 自带幂等，无需 case 守卫 */
export function rcBlockFish(type: SdkTypeId): string {
  const spec = getSdkType(type);
  const binSuffix = spec.envBinSuffix(detectPlatform()).replace(/\\/g, '/');
  const abs = paths.current(type);
  const toPosix = (p: string) => p.split(path.sep).join('/');
  // miniconda 的 rcExtra 是 bash 语法（source conda.sh），fish 不能复用：
  // 导出等价变量并提示跑一次 conda init fish 获得 conda activate
  const extra =
    type === 'miniconda'
      ? [
          `set -gx CONDA_EXE "$${spec.envVar}/bin/conda"`,
          `set -gx CONDA_PYTHON_EXE "$${spec.envVar}/bin/python"`,
          `# fish 下 conda activate 需要（只需一次）: conda init fish`,
        ]
      : [];
  return [
    rcBegin(type),
    `set -gx ${spec.envVar} '${toPosix(abs).replace(/'/g, "'\\''")}'`,
    // fish_add_path 是 3.2+ 才有：更老的 fish 里静默失败，PATH 不生效也不报错。
    // 退回 contains + set -gx（全部版本可用，幂等）
    'if type -q fish_add_path',
    `  fish_add_path -p "$${spec.envVar}${binSuffix}"`,
    `else if not contains "$${spec.envVar}${binSuffix}" $PATH`,
    `  set -gx PATH "$${spec.envVar}${binSuffix}" $PATH`,
    'end',
    ...extra,
    rcEnd(type),
  ].join('\n');
}

/** 删除指定类型的标记块（幂等） */
export function stripRcBlock(content: string, type: SdkTypeId): string {
  return stripBlockBetween(content, rcBegin(type), rcEnd(type));
}

/** 行首锚定：标记必须独占一行（允许首尾空白）才算 sdkvm 的块边界。
 * 用户内容里行中出现的标记文本（echo "# >>> sdkvm java init >>>" 之类）不是边界，
 * 按旧的正则前缀匹配会把那一行连同后续内容一起吞掉。 */
function isMarkerLine(line: string, marker: string): boolean {
  return line.trim() === marker;
}

function stripBlockBetween(content: string, begin: string, end: string): string {
  const lines = content.split('\n');
  const isAnySdkvmMarker = (l: string) => /^# (?:>>>|<<<) sdkvm /.test(l.trimStart());
  const out: string[] = [];
  let fixedUnterminated = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!isMarkerLine(line, begin)) {
      out.push(line);
      i += 1;
      continue;
    }
    // 完整块：begin 行到 end 行（含）整段移除；块内再出现的 begin 属于块内容，随块删除
    let j = i + 1;
    while (j < lines.length && !isMarkerLine(lines[j]!, end)) j += 1;
    if (j < lines.length) {
      i = j + 1;
      continue;
    }
    // 半损坏块（end 标记被删/改）：删除到下一个 sdkvm 块标记行为止；
    // 其后没有其它标记时无法区分"块内容"与用户自己的配置，仅移除标记行本身，
    // 绝不删到文件尾
    let k = i + 1;
    while (k < lines.length && !isAnySdkvmMarker(lines[k]!)) k += 1;
    i = k < lines.length ? k : i + 1;
    fixedUnterminated = true;
  }
  if (fixedUnterminated) {
    log.warn(
      `found an unterminated ${CLI_BIN} init marker in the rc file; removed the dangling marker (and its orphaned lines) — check the file manually`,
    );
  }
  return out.join('\n');
}

/** 确保文件末尾恰好包含一个该类型的标记块；返回最终文件内容 */
export function upsertRcContent(content: string, type: SdkTypeId, blockText?: string): string {
  // 只裁行尾换行，不裁 \r 之外的空白（\s 会把 CRLF 文件最后的 CR 也吃掉）
  const stripped = stripRcBlock(content, type).replace(/(?:\r?\n)+\s*$/, '');
  const crlf = (content.match(/\r\n/g) ?? []).length;
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length;
  const eol = crlf > lf ? '\r\n' : '\n';
  const block = (blockText ?? rcBlock(type)).replaceAll('\n', eol);
  return `${stripped}${eol}${eol}${block}${eol}`;
}

/** 不同 SDKVM_HOME 的锁互不相干，却可能写同一份 rc。用目标文件旁的目录锁串行化读-改-写。 */
function withRcFileLock(file: string, fn: () => void): void {
  const lockDir = `${file}.sdkvm-lock`;
  // 锁目录和 rc 在同一层。fish 的 ~/.config/fish 第一次 use 时还不存在。
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + 10_000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 30_000) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting to update ${file}`);
      }
      Atomics.wait(pause, 0, 0, 50);
    }
  }
  try {
    fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // 残留锁按 30 秒龄被下一次接管
    }
  }
}

/** 原子写 rc：tmp+rename，避免 O_TRUNC 直接写在写一半崩溃时截断用户文件 */
function writeRcAtomic(file: string, content: string): void {
  // rc 常被 chezmoi/stow 等做成符号链接：rename 会把链接替换成普通文件，
  // 脱离用户的 dotfile 管理。写透到链接目标（读侧 readFileSync 本来就跟随链接）
  try {
    if (fs.lstatSync(file).isSymbolicLink()) file = fs.realpathSync(file);
  } catch {
    // 不存在或目标读不出：按原路径写
  }
  const tmp = `${file}.sdkvm-tmp-${process.pid}`;
  let mode: number | undefined;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // 目标不存在（首次写入）：用默认权限
  }
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清不掉的 tmp 下次写入会覆盖同名文件
    }
    throw err;
  }
}

/** 写入 rc 文件（不存在则创建）。非 UTF-8 内容先备份，避免替换字符写回造成永久破坏 */
export function upsertRcFile(file: string, type: SdkTypeId, blockText?: string): void {
  withRcFileLock(file, () => upsertRcFileUnlocked(file, type, blockText));
}

function upsertRcFileUnlocked(file: string, type: SdkTypeId, blockText?: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    // 首次创建同样走 tmp+rename：writeFileSync 写到一半崩溃会留下半截 rc，
    // 下次会被当成合法 UTF-8 保留
    writeRcAtomic(file, upsertRcContent('', type, blockText));
    return;
  }
  const raw = fs.readFileSync(file);
  const content = raw.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(raw)) {
    const bak = `${file}.sdkvm-bak`;
    fs.copyFileSync(file, bak);
    log.warn(`${file} is not valid UTF-8; original backed up to ${bak}`);
  }
  writeRcAtomic(file, upsertRcContent(content, type, blockText));
}

export function removeRcBlockFromFile(file: string, type: SdkTypeId): void {
  withRcFileLock(file, () => removeRcBlockFromFileUnlocked(file, type));
}

function removeRcBlockFromFileUnlocked(file: string, type: SdkTypeId): void {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file);
  const content = raw.toString('utf8');
  const stripped = stripRcBlock(content, type);
  if (stripped === content) return;
  // 与 upsertRcFile 相同的保护：非 UTF-8 字节先备份再写回
  if (!Buffer.from(content, 'utf8').equals(raw)) {
    const bak = `${file}.sdkvm-bak`;
    fs.copyFileSync(file, bak);
    log.warn(`${file} is not valid UTF-8; original backed up to ${bak}`);
  }
  writeRcAtomic(file, stripped);
}

