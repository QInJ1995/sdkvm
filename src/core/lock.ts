import fs from 'node:fs';
import { paths } from './paths.js';
import { SdkvmError } from '../util/errors.js';
import { log } from '../ui/log.js';

const STALE_MS = 5 * 60 * 1000;
/** 持锁期间刷新 mtime，避免长下载被当成 stale */
const HEARTBEAT_MS = 60 * 1000;

function lockInfoPath(): string {
  return `${paths.lock()}/info.json`;
}

function readLockPid(): number | null {
  try {
    const raw = fs.readFileSync(lockInfoPath(), 'utf8');
    const parsed = JSON.parse(raw) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但当前用户无权发信号（Windows 上其它会话的进程）——视为存活，不能偷锁
    if ((err as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function writeLockInfo(startedAt: number): void {
  // tmp+rename 原子写：mkdir 之后、info.json 写完之前崩溃，等待者会误判 holder 未知而白等 STALE_MS
  const file = lockInfoPath();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt, heartbeatAt: Date.now() }));
  fs.renameSync(tmp, file);
}

/** 心跳连续失败计数：dir mtime 刷不上来，STALE_MS 后锁会被别人当 stale 清走 */
let heartbeatFailures = 0;

function touchLock(): void {
  const lockDir = paths.lock();
  if (!fs.existsSync(lockDir)) return;
  const now = new Date();
  let mtimeOk = false;
  try {
    fs.utimesSync(lockDir, now, now);
    mtimeOk = true;
  } catch {
    // ignore
  }
  try {
    // 只在锁目录明确归属自己时刷新 info.json：holder 未知（info.json 缺失/损坏）时
    // 贸然写入会把别人的锁据为己有，等 STALE_MS 让等待者按 stale 处理更安全。
    const pid = readLockPid();
    if (pid === process.pid) {
      let startedAt = Date.now();
      try {
        const raw = JSON.parse(fs.readFileSync(lockInfoPath(), 'utf8')) as { startedAt?: number };
        if (typeof raw.startedAt === 'number') startedAt = raw.startedAt;
      } catch {
        // rewrite below
      }
      writeLockInfo(startedAt);
    }
  } catch {
    // ignore
  }
  heartbeatFailures = mtimeOk ? 0 : heartbeatFailures + 1;
  if (heartbeatFailures === 3) {
    log.warn('sdkvm lock heartbeat keeps failing; another sdkvm may treat this lock as stale');
  }
}

function removeLockDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    throw new SdkvmError(`Cannot clear the stale lock at ${dir}`, {
      hint: `${(err as Error).message}. Close other sdkvm processes, then remove the directory manually.`,
    });
  }
}

/**
 * 偷锁必须原子：先把锁目录 rename 成自己的暂存名，只有唯一赢家（其余 ENOENT），
 * 再由赢家清理暂存目录。直接 rmSync + mkdir 的话，两个等待者可以先后删掉彼此的新锁。
 */
function stealLock(lockDir: string): boolean {
  const staging = `${lockDir}.stale-${process.pid}`;
  try {
    fs.renameSync(lockDir, staging);
  } catch {
    // 锁已被其他等待者偷走或持有者刚释放：回到上层重取
    return false;
  }
  removeLockDir(staging);
  return true;
}

/** mkdir 原子锁：防止并发 install/uninstall 写冲突 */
export function acquireLock(): void {
  const lockDir = paths.lock();
  fs.mkdirSync(paths.root(), { recursive: true });
  try {
    fs.mkdirSync(lockDir);
    writeLockInfo(Date.now());
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') {
      const holder = readLockPid();
      if (holder != null && !isProcessAlive(holder)) {
        stealLock(lockDir);
        return acquireLock();
      }
      // 持有者可能恰好在此期间退出（或另一个等待者已清走锁）：锁没了就直接重取
      let stat: fs.Stats;
      try {
        stat = fs.statSync(lockDir);
      } catch {
        return acquireLock();
      }
      if (Date.now() - stat.mtimeMs > STALE_MS) {
        stealLock(lockDir);
        return acquireLock();
      }
      throw new SdkvmError('Another sdkvm operation is in progress', {
        hint: 'If this is wrong, remove ~/.sdkvm/.lock manually.',
      });
    }
    throw e;
  }
}

export function releaseLock(): void {
  // 锁可能已按 stale 被别人偷走：只有 info.json 仍归属自己时才删除
  if (readLockPid() === process.pid) {
    fs.rmSync(paths.lock(), { recursive: true, force: true });
  }
}

export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  acquireLock();
  const timer = setInterval(() => touchLock(), HEARTBEAT_MS);
  // 不让 timer 拖住进程退出
  timer.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    try {
      releaseLock();
    } catch (err) {
      // 释放失败（如 Windows 杀软短暂锁文件）不能吞掉真正的业务异常
      if (err instanceof SdkvmError) {
        log.warn(err.message);
      } else {
        log.warn(`failed to release the sdkvm lock: ${(err as Error).message}`);
      }
    }
  }
}
