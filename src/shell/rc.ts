import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isProcessAlive } from '../core/lock.js';
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
  const posixAbs = toPosix(abs);
  // 根目录在 home 之外（SDKVM_HOME 自定义，或跨盘导致 path.relative 返回绝对路径）时退回绝对 posix 路径
  const fallbackAbs = rel.startsWith('..') || path.isAbsolute(rel);
  // 写进 rc 的是 posix 路径。Windows 的 \ 只是分隔符，转成 / 之后不再算元字符。
  // 路径仍含 " / ` / $ / ! / \ 时改用单引号：双引号挡不住 history expansion 和反斜杠转义，
  // 单引号也会关掉 $HOME 展开，所以这时不用相对形式。
  const needsLiteral = /["'`$!\\]/.test(posixAbs);
  const link = needsLiteral
    ? `'${posixAbs.replace(/'/g, `'\\''`)}'`
    : fallbackAbs
      ? posixAbs
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

/**
 * fish 单引号里只有 `\'` 和 `\\` 有意义。
 * bash/zsh 的 `'\''` 拼接写进 config.fish 不是合法转义。
 */
export function fishSingleQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
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
    `set -gx ${spec.envVar} ${fishSingleQuote(toPosix(abs))}`,
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

/** 读 rc 旁路锁目录里的持有者 pid；缺失/损坏返回 null */
function readRcLockPid(lockDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * 偷过期/无主的 rc 旁路锁。与 core/lock.ts 同款：先 rename 再删，
 * 禁止 rm+mkdir——两个等待者会先后删掉彼此刚建的新锁，双持锁写坏同一份 rc。
 */
function stealRcLock(lockDir: string): boolean {
  const staging = `${lockDir}.stale-${process.pid}`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch {
    // rename 时再暴露
  }
  try {
    fs.renameSync(lockDir, staging);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch {
    // 残留无害：下次同 pid 偷锁会先清 staging
  }
  return true;
}

/** mkdir 与 pid 落盘之间被杀掉的无主锁：合法持有者毫秒级写完 pid，
 *  短宽限期后再偷，避免两个并发 use 互相拆掉对方刚建的空锁目录 */
const RC_ORPHAN_GRACE_MS = 2_000;

/** 清掉死进程留下的 `.sdkvm-lock.stale-<pid>` / `.rel-<pid>`（rm 失败或死在 rename 与 rm 之间） */
function sweepRcLockStaging(lockDir: string): void {
  const dir = path.dirname(lockDir);
  const base = path.basename(lockDir);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const at = name.lastIndexOf('.stale-') !== -1 ? name.lastIndexOf('.stale-') : name.lastIndexOf('.rel-');
    if (at === -1 || !name.startsWith(base) || !/^\.(stale|rel)-\d+$/.test(name.slice(at))) continue;
    const pid = Number(name.slice(at).split('-')[1]);
    if (Number.isInteger(pid) && isProcessAlive(pid)) continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      // 清不掉就留着，不影响本次持锁
    }
  }
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
      try {
        // wx：独占声明持有。orphan 宽限后别人可能已 steal+重建同一路径；
        // 非独占 write 会盖掉对方 pid，两边复核都通过 → 双持锁交错 RMW。
        // EEXIST 说明目录里已有别人的声明——绝不能 rm 整个 lockDir
        fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`, { flag: 'wx' });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // EEXIST：别人已声明；ENOENT：目录已被 steal 挪走。都不能盲 rm
        if (code === 'EEXIST' || code === 'ENOENT') {
          continue;
        }
        try {
          const holder = readRcLockPid(lockDir);
          if (holder == null || holder === process.pid) {
            fs.rmSync(lockDir, { recursive: true, force: true });
          }
        } catch {
          // 留给 stale / 死 pid 路径接管
        }
        throw err;
      }
      // 写完立刻复核：steal 窗口里目录可能已被换走再重建
      if (readRcLockPid(lockDir) !== process.pid) {
        continue;
      }
      sweepRcLockStaging(lockDir);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = readRcLockPid(lockDir);
      let stale = holder != null && !isProcessAlive(holder);
      if (!stale && holder == null) {
        // 只对无主锁（mkdir 与写 pid 之间）按短宽限期偷；
        // 活持有者绝不按龄偷——rc 写无心跳，30s 龄偷会让多 SDKVM_HOME 并发写坏同一份 rc
        try {
          stale = Date.now() - fs.statSync(lockDir).mtimeMs > RC_ORPHAN_GRACE_MS;
        } catch {
          continue; // 锁目录恰好消失：直接重取
        }
      }
      if (stale) {
        stealRcLock(lockDir);
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
    // 先 rename 再核对 pid：直接 rm 会在"被别人偷走并转手"的窗口删掉新持有者的锁
    const staging = `${lockDir}.rel-${process.pid}`;
    try {
      fs.renameSync(lockDir, staging);
    } catch {
      return;
    }
    if (readRcLockPid(staging) === process.pid) {
      try {
        fs.rmSync(staging, { recursive: true, force: true });
      } catch {
        // 残留按死 pid / 龄被下一次接管
      }
    } else {
      try {
        fs.renameSync(staging, lockDir);
      } catch {
        // 对方已重建锁目录：staging 残留无害
      }
    }
  }
}

/** 解析 rc 路径上的符号链接链（含悬空）：返回最终应写入的路径。 */
function resolveRcWriteTarget(file: string): string {
  // rc 常被 chezmoi/stow 做成符号链接：rename 会把链接本身换成普通文件，
  // 脱离用户的 dotfile 管理。写透到链接目标（读侧 readFileSync 本来就跟随链接）。
  // 悬空链接 realpathSync 会抛——被吞后按原路径 rename 会顶掉链接；逐层 readlink
  // 拼出目标路径，即使目标尚未创建也写到那里（与 mrm writeSettings 同款）
  let cur = file;
  for (let hops = 0; hops < 8; hops++) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return cur;
      throw err;
    }
    if (!st.isSymbolicLink()) return cur;
    cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur));
  }
  // 达上限仍是链接：绝不能对 symlink 路径 rename（会把链接顶成普通文件）
  throw new Error(`too many levels of symbolic links while resolving ${file}`);
}

/** 原子写 rc：tmp+rename，避免 O_TRUNC 直接写在写一半崩溃时截断用户文件 */
function writeRcAtomic(file: string, content: string): void {
  file = resolveRcWriteTarget(file);
  const tmp = `${file}.sdkvm-tmp-${process.pid}`;
  let mode: number | undefined;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // 目标不存在（首次写入 / 悬空链接）：用默认权限
  }
  // 悬空链接的目标目录可能还不存在（stow 尚未到位）：先建父目录
  fs.mkdirSync(path.dirname(file), { recursive: true });
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

const RC_TOUCHED_CAP = 64;

/** 记下写过的 rc 绝对路径，供卸载扫历史 XDG / 换过的 fish 配置 */
function rememberRcPath(file: string): void {
  try {
    const abs = path.resolve(file);
    fs.mkdirSync(paths.root(), { recursive: true });
    const store = paths.rcTouched();
    let list: string[] = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(store, 'utf8'));
      if (Array.isArray(parsed)) {
        list = parsed.filter((x): x is string => typeof x === 'string');
      }
    } catch {
      // 损坏或首次：从空列表重建
    }
    if (list.includes(abs)) return;
    list.push(abs);
    if (list.length > RC_TOUCHED_CAP) list = list.slice(-RC_TOUCHED_CAP);
    fs.writeFileSync(store, `${JSON.stringify(list)}\n`);
  } catch {
    // 记不住不影响本次写入；最坏卸载扫不全历史路径
  }
}

/** 卸载时与 rcCandidates 合并：覆盖曾经写过、当前环境变量已变的路径 */
export function rememberedRcPaths(): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(paths.rcTouched(), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((x): x is string => typeof x === 'string'))];
  } catch {
    return [];
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
    rememberRcPath(file);
    return;
  }
  const raw = fs.readFileSync(file);
  const content = raw.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(raw)) {
    // 备份写在真实目标旁（与 writeRcAtomic 同路径），别把 bak 甩在 symlink 旁边
    const target = resolveRcWriteTarget(file);
    const bak = `${target}.sdkvm-bak`;
    fs.copyFileSync(file, bak);
    log.warn(`${file} is not valid UTF-8; original backed up to ${bak}`);
  }
  writeRcAtomic(file, upsertRcContent(content, type, blockText));
  rememberRcPath(file);
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
    const target = resolveRcWriteTarget(file);
    const bak = `${target}.sdkvm-bak`;
    fs.copyFileSync(file, bak);
    log.warn(`${file} is not valid UTF-8; original backed up to ${bak}`);
  }
  writeRcAtomic(file, stripped);
}

