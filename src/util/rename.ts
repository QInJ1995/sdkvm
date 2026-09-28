import fs from 'node:fs';
import { log } from '../ui/log.js';

/** Windows 上杀软可能短暂锁住新解压的文件导致 rename 失败，重试兜底 */
export async function renameWithRetry(from: string, to: string, attempts = 3): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      log.warn(`rename blocked (attempt ${i}/${attempts}), retrying in 1s ...`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
