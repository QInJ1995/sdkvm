import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../core/paths.js';
import { SdkvmError } from '../util/errors.js';
import { log } from '../ui/log.js';
import type { Platform } from '../core/platform.js';
import type { SdkTypeId } from '../sdk/types.js';

/** current-* 位置被真实目录占用（用户手建 / 旧版残留）而非链接。
 *  Windows junction 的 lstat 不是 symlink，但 readlink 能读出目标——真目录会抛 EINVAL。 */
function isRealDirectory(p: string): boolean {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    try {
      fs.readlinkSync(p);
      return false; // junction / 目录符号链接
    } catch {
      return true;
    }
  } catch {
    return false; // 不存在
  }
}

/** 切换某类型的 current 指向（target 必须是绝对路径）。Unix 原子 rename；Windows junction 重建。 */
export function setCurrent(type: SdkTypeId, target: string, platform: Platform): void {
  const link = paths.current(type);
  if (isRealDirectory(link)) {
    throw new SdkvmError(`refusing to replace ${link}: it is a real directory, not a symlink`, {
      hint: 'It looks hand-created. Move it away (or merge its contents into an installed SDK) and retry; sdkvm will then manage the link itself.',
    });
  }
  if (platform.os === 'windows') {
    // junction 要求绝对路径；无法 rename 覆盖，只能重建（窗口期极短）
    try {
      fs.rmSync(link, { force: true });
    } catch {
      fs.rmSync(link, { recursive: true, force: true });
    }
    fs.symlinkSync(target, link, 'junction');
    return;
  }
  const tmp = `${link}.tmp-${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(target, tmp);
  fs.renameSync(tmp, link);
}

/** current 不存在或损坏返回 null */
export function readCurrent(type: SdkTypeId): string | null {
  const link = paths.current(type);
  try {
    const st = fs.lstatSync(link);
    if (!st.isSymbolicLink()) return null;
    const raw = fs.readlinkSync(link) as string;
    return path.resolve(path.dirname(link), raw);
  } catch {
    return null;
  }
}

export function clearCurrent(type: SdkTypeId): void {
  const link = paths.current(type);
  // 真目录不是我们的链接：recursive rm 会把用户的目录整个删掉，宁可留着并明说
  if (isRealDirectory(link)) {
    log.warn(`${link} is a real directory (not managed by sdkvm); left in place`);
    return;
  }
  try {
    fs.rmSync(link, { force: true });
  } catch {
    fs.rmSync(link, { recursive: true, force: true });
  }
}
