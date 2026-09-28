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
    const pid = readLockPid() ?? process.pid;
    let startedAt = Date.now();
    try {
      const raw = JSON.parse(fs.readFileSync(lockInfoPath(), 'utf8')) as { startedAt?: number };
      if (typeof raw.startedAt === 'number') startedAt = raw.startedAt;
    } catch {
      // rewrite below
    }
    if (pid === process.pid) writeLockInfo(startedAt);
  } catch {
    // ignore
  }
  heartbeatFailures = mtimeOk ? 0 : heartbeatFailures + 1;
  if (heartbeatFailures === 3) {
    log.warn('sdkvm lock heartbeat keeps failing; another sdkvm may treat this lock as stale');
  }
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
        fs.rmSync(lockDir, { recursive: true, force: true });
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
        fs.rmSync(lockDir, { recursive: true, force: true });
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
  fs.rmSync(paths.lock(), { recursive: true, force: true });
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
    releaseLock();
  }
}
