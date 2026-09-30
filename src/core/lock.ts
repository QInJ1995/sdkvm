import fs from 'node:fs';
import path from 'node:path';
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

/** pid 存活探测（tmp 残留清扫也用它区分"活跃进程的文件"与"死进程的遗留"） */
export function isProcessAlive(pid: number): boolean {
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
  // 锁可能已被别人按 stale 偷走：心跳只续自己的锁，不替新持有者刷新 mtime
  //（否则新持有者真挂了，它的锁也永远不到 STALE_MS，第三个进程会一直等）
  if (readLockPid() !== process.pid) return;
  const now = new Date();
  let mtimeOk = false;
  try {
    fs.utimesSync(lockDir, now, now);
    mtimeOk = true;
  } catch {
    // ignore
  }
  try {
    let startedAt = Date.now();
    try {
      const raw = JSON.parse(fs.readFileSync(lockInfoPath(), 'utf8')) as { startedAt?: number };
      if (typeof raw.startedAt === 'number') startedAt = raw.startedAt;
    } catch {
      // rewrite below
    }
    writeLockInfo(startedAt);
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
 * 返回 false 仅表示锁目录已不在（被抢先偷走 / 持有者刚释放），上层可以重取；
 * 持续性失败（staging 撞残留目录、权限）直接抛错，绝不能让上层无限重试。
 */
function stealLock(lockDir: string): boolean {
  const staging = `${lockDir}.stale-${process.pid}`;
  // 同名 staging 只可能来自复用了本 pid 的已死进程（活着的话 pid 唯一不会撞名）：
  // 先清掉，否则 rename 会因目标非空持续 ENOTEMPTY
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch {
    // 清不掉会在下面 rename 时以明确错误暴露
  }
  try {
    fs.renameSync(lockDir, staging);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // 源不在了：被其他等待者抢先偷走或持有者刚释放，回到上层重取
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw new SdkvmError(`Cannot clear the stale lock at ${lockDir}`, {
      hint: `${(err as Error).message}. Close other sdkvm processes, then remove the directory manually.`,
    });
  }
  removeLockDir(staging);
  return true;
}

/**
 * 清理历史偷锁/释放残留的 `.lock.stale-<pid>`、`.lock.rel-<pid>` 目录（rm 失败、
 * 或进程死在 rename 与 rm 之间）。只在持有锁时调用；staging 主人还活着就跳过——
 * 它正要自己删。
 */
function sweepStaleStaging(lockDir: string): void {
  const root = paths.root();
  const base = path.basename(lockDir);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const at = name.lastIndexOf('.stale-') !== -1 ? name.lastIndexOf('.stale-') : name.lastIndexOf('.rel-');
    if (at === -1 || !name.startsWith(base) || !/^\.(stale|rel)-\d+$/.test(name.slice(at))) continue;
    const pid = Number(name.slice(at).split('-')[1]);
    if (Number.isInteger(pid) && isProcessAlive(pid)) continue;
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true });
    } catch {
      // 清不掉就留着，不影响本次持锁
    }
  }
}

/** mkdir 与 info.json 落盘之间被 SIGKILL 的无主锁：合法持有者的 info.json 在建目录后
 *  毫秒级出现（tmp+rename 原子写），等这几秒还不出现就是创建者已死，别按
 *  "holder 未知"一路忙等满 STALE_MS */
const ORPHAN_GRACE_MS = 5_000;

/** 本进程持有的锁深度：updateConfig 等嵌套调用不再自锁死（原先第二层 acquire 会抛
 *  "Another sdkvm operation is in progress"并提示自己删锁） */
let heldDepth = 0;

/** mkdir 原子锁：防止并发 install/uninstall 写冲突 */
export function acquireLock(): void {
  if (heldDepth > 0) {
    heldDepth += 1;
    return;
  }
  const lockDir = paths.lock();
  fs.mkdirSync(paths.root(), { recursive: true });
  // 竞态重试（持有者恰好退出、锁被别的等待者抢先偷走）有界进行：
  // 持续失败说明环境性问题，无限递归只会栈溢出
  let transient = 0;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      try {
        writeLockInfo(Date.now());
      } catch (err) {
        // 刚建出的目录写不进 info.json（磁盘满/杀软拦截新目录）：回滚删掉，
        // 否则留下一个无 pid、mtime 新鲜的锁目录，把本机所有操作楔到 STALE_MS
        try {
          fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {
          // 删不掉只能留给 stale 兜底（与被 SIGKILL 的窗口同款下场）
        }
        throw err;
      }
      sweepStaleStaging(lockDir);
      heldDepth = 1;
      return;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') throw e;
      const holder = readLockPid();
      let stale = holder != null && !isProcessAlive(holder);
      if (!stale) {
        // holder 存活：等满 STALE_MS；holder 未知（info.json 缺失＝创建者死在
        // 建目录与写 info 之间）：无主锁只等短宽限期，别把本机楔满 5 分钟
        const limit = holder == null ? ORPHAN_GRACE_MS : STALE_MS;
        try {
          stale = Date.now() - fs.statSync(lockDir).mtimeMs > limit;
        } catch {
          stale = true; // 锁目录恰好消失（持有者刚释放或已被清走）：直接重取
        }
      }
      if (!stale) {
        throw new LockBusyError(lockDir);
      }
      if (stealLock(lockDir)) continue; // 偷到了，下一轮 mkdir 应当成功
      transient += 1;
      if (transient > 10) {
        throw new SdkvmError(`Cannot acquire the lock at ${lockDir}`, {
          hint: 'The lock directory keeps changing under us — another sdkvm may be racing this one. Retry in a moment.',
        });
      }
    }
  }
}

/** 他人持锁：唯一可等待重试的锁错误（4xx 类），其余（损坏、权限）立即抛 */
export class LockBusyError extends SdkvmError {
  constructor(readonly lockDir: string) {
    super('Another sdkvm operation is in progress', {
      // SDKVM_HOME 自定义时锁不在 ~/.sdkvm，必须给实际路径
      hint: `If this is wrong, remove ${lockDir} manually.`,
    });
    this.name = 'LockBusyError';
  }
}

export function releaseLock(): void {
  if (heldDepth > 1) {
    heldDepth -= 1;
    return;
  }
  heldDepth = 0;
  const lockDir = paths.lock();
  const staging = `${lockDir}.rel-${process.pid}`;
  // 先 rename 占有再校验再删：直接 check-then-rm 的话，读到自己的 pid 后、rm 之前
  // 锁被别人偷走并转手，rm 会删掉新持有者的锁。rename 只有唯一赢家
  try {
    fs.renameSync(lockDir, staging);
  } catch {
    releaseAbandonedLock(lockDir, staging);
    return;
  }
  const owner = readRelPid(staging);
  if (owner !== process.pid) {
    // 抢到的不是自己的锁（偷锁竞态窗口）：原样还回去
    try {
      fs.renameSync(staging, lockDir);
    } catch {
      // 还不回去（对方已重建锁目录）：staging 由 sweepStaleStaging 兜底清理
    }
    return;
  }
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch {
    // 残留由 sweepStaleStaging 按 .rel- 前缀兜底清理
  }
}

/** 自己的锁目录已被偷锁者挪走时的收尾：偷锁者读到 pid≠自己会把目录"还回"，
 *  但本进程已放弃持有，还回来的会是一把无主锁（把后来的操作楔到 mtime 过期）。
 *  清掉所有写着本 pid 的遗留 staging，让对方的"还回"扑空；.lock 若已被还回
 *  且内容仍是本 pid，认领后删除 */
function releaseAbandonedLock(lockDir: string, staging: string): void {
  const root = paths.root();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  const base = path.basename(lockDir);
  for (const name of names) {
    if (!name.startsWith(`${base}.rel-`) && !name.startsWith(`${base}.stale-`)) continue;
    const dir = path.join(root, name);
    // 写着本 pid 的 staging：要么是偷锁者手里的本进程旧锁（内容已无价值），
    // 要么是本进程自己历史释放的残留——都可以删
    if (readRelPid(dir) === process.pid) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 清不掉由 sweepStaleStaging 兜底
      }
    }
  }
  // "还回"已发生且内容仍是本 pid：认领删除（认领瞬间又易主则还回，同主流程语义）
  try {
    if (readLockPid() !== process.pid) return;
    fs.renameSync(lockDir, staging);
  } catch {
    return;
  }
  const owner = readRelPid(staging);
  if (owner !== process.pid) {
    try {
      fs.renameSync(staging, lockDir);
    } catch {
      // sweep 兜底
    }
    return;
  }
  try {
    fs.rmSync(staging, { recursive: true, force: true });
  } catch {
    // sweep 兜底
  }
}

/** 从 .lock.rel-<pid> 暂存目录里读持有者 pid（info.json 缺失/损坏返回 null） */
function readRelPid(staging: string): number | null {
  try {
    const raw = JSON.parse(fs.readFileSync(`${staging}/info.json`, 'utf8')) as { pid?: unknown };
    return typeof raw.pid === 'number' ? raw.pid : null;
  } catch {
    return null;
  }
}

const WAIT_POLL_MS = 200;

/**
 * 持锁执行。他人持锁时默认立即抛 LockBusyError；给 waitMs 则有界等待
 * （安装的变更阶段在长下载之后，等几秒远好过把整次下载作废）。
 * 等待期间锁过期会被持有者的下一次尝试顺路偷掉，不会干等到底。
 */
export async function withLock<T>(fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  const deadline = Date.now() + (opts.waitMs ?? 0);
  for (;;) {
    try {
      acquireLock();
      break;
    } catch (err) {
      if (!(err instanceof LockBusyError) || Date.now() >= deadline) throw err;
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
  }
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
