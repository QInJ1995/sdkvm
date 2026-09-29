import fs from 'node:fs';
import { log } from '../ui/log.js';

/** 瞬态失败（Windows 杀软短暂锁文件）才值得重试；EXDEV/ENOENT/EINVAL 是确定性失败 */
function isTransientRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

/** Windows 上杀软可能短暂锁住新解压的文件导致 rename 失败，重试兜底 */
export async function renameWithRetry(from: string, to: string, attempts = 3): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= attempts || !isTransientRenameError(err)) throw err;
      log.warn(`rename blocked (attempt ${i}/${attempts}), retrying in 1s ...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
