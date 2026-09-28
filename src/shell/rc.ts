import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from '../core/paths.js';
import { detectPlatform } from '../core/platform.js';
import { getSdkType } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';
import { CLI_BIN } from '../cli/cmdname.js';
import { log } from '../ui/log.js';
import { escapeRegExp as escapeRegex } from '../util/regex.js';

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
  // 路径含 " / ` / $ 时改用单引号字面量，防止写入 rc 的 export 行被注入或意外展开；
  // 此时也不用 $HOME/ 相对形式（单引号会关掉展开）
  const needsLiteral = /["'$`]/.test(abs);
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

/** 删除指定类型的标记块（幂等） */
export function stripRcBlock(content: string, type: SdkTypeId): string {
  return stripBlockBetween(content, rcBegin(type), rcEnd(type));
}

function stripBlockBetween(content: string, begin: string, end: string): string {
  const re = new RegExp(`\\n*${escapeRegex(begin)}[\\s\\S]*?${escapeRegex(end)}\\n*`, 'g');
  let out = content.replace(re, '\n');
  // 半损坏块（end 标记被删/改）也要清掉：从 begin 起删到文件尾，避免 upsert 追加出重复块
  const broken = new RegExp(`\\n*${escapeRegex(begin)}[\\s\\S]*$`);
  out = out.replace(broken, '\n');
  return out;
}

/** 确保文件末尾恰好包含一个该类型的标记块；返回最终文件内容 */
export function upsertRcContent(content: string, type: SdkTypeId): string {
  const stripped = stripRcBlock(content, type).replace(/\s+$/, '');
  return `${stripped}\n\n${rcBlock(type)}\n`;
}

/** 写入 rc 文件（不存在则创建）。非 UTF-8 内容先备份，避免替换字符写回造成永久破坏 */
export function upsertRcFile(file: string, type: SdkTypeId): void {
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, upsertRcContent('', type));
    return;
  }
  const raw = fs.readFileSync(file);
  const content = raw.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(raw)) {
    const bak = `${file}.sdkvm-bak`;
    fs.copyFileSync(file, bak);
    log.warn(`${file} is not valid UTF-8; original backed up to ${bak}`);
  }
  fs.writeFileSync(file, upsertRcContent(content, type));
}

export function removeRcBlockFromFile(file: string, type: SdkTypeId): void {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  const stripped = stripRcBlock(content, type);
  if (stripped !== content) fs.writeFileSync(file, stripped);
}

