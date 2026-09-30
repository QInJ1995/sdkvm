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
    // junction 要求绝对路径；无法 rename 覆盖，只能重建。先把旧链接挪到一边再建新的：
    // 直接 rm+symlink 时，symlink 失败（路径策略/杀软）会连旧链接一起丢，
    // 挪开后新链接失败可把旧的换回来
    const aside = `${link}.old-${process.pid}`;
    fs.rmSync(aside, { recursive: true, force: true });
    let hadOld = false;
    try {
      fs.renameSync(link, aside);
      hadOld = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT：链接不存在（首次 use）。其它失败（EPERM/EBUSY——杀软或索引器
      // 短暂占用 junction）不能当首次处理：随后 symlinkSync 撞同名残留会报出
      // 误导性的错误，且掩盖真实的占用问题
      if (code !== 'ENOENT') {
        throw new SdkvmError(`Failed to move the old link ${link} aside: ${(err as Error).message}`, {
          hint: 'Usually a transient lock by antivirus or a search indexer. Wait a few seconds and retry; the link was left unchanged.',
        });
      }
    }
    try {
      fs.symlinkSync(target, link, 'junction');
    } catch (err) {
      if (hadOld) {
        try {
          fs.renameSync(aside, link);
        } catch {
          // 还原也失败：aside 留在原地，下面的错误信息带上它
        }
      }
      throw new SdkvmError(`Failed to point the current link at ${target}: ${(err as Error).message}`, {
        hint: hadOld && fs.existsSync(aside)
          ? `The previous link was kept at ${aside}; rename it back to ${link} by hand if needed.`
          : `Create the junction manually if this keeps failing.`,
      });
    }
    try {
      fs.rmSync(aside, { recursive: true, force: true });
    } catch {
      // 旧链接删不掉（杀软短暂占用）：留着无害，下次 use 会以新 pid 重建 aside 名
    }
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
