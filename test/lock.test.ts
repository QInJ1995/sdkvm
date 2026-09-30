import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isProcessAlive } from '../src/core/lock.js';

let home: string;

/** 每个用例拿一份全新的锁模块：heldDepth 是模块级状态，
 *  上一用例的 acquire/release 不配对会污染本用例的语义 */
async function freshLock(): Promise<typeof import('../src/core/lock.js')> {
  vi.resetModules();
  return import('../src/core/lock.js');
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-lock-'));
  process.env.SDKVM_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.SDKVM_HOME;
  vi.restoreAllMocks();
});

describe('lock', () => {
  it('same-process second acquire is reentrant (nested updateConfig no longer self-deadlocks)', async () => {
    const { acquireLock, releaseLock } = await freshLock();
    acquireLock();
    expect(() => acquireLock()).not.toThrow();
    releaseLock();
    // 内层释放只回退计数：锁仍归本进程，目录还在
    expect(fs.existsSync(path.join(home, '.lock'))).toBe(true);
    releaseLock();
    expect(fs.existsSync(path.join(home, '.lock'))).toBe(false);
    // 完全释放后可以再次获取
    expect(() => acquireLock()).not.toThrow();
    releaseLock();
  });

  it('busy error hint names the actual lock path (SDKVM_HOME aware)', async () => {
    const { acquireLock } = await freshLock();
    fs.mkdirSync(path.join(home, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lock', 'info.json'), JSON.stringify({ pid: process.pid }));
    let hint: string | undefined;
    try {
      acquireLock();
      expect.unreachable('acquire with an external live holder should throw');
    } catch (err) {
      hint = (err as { hint?: string }).hint;
      expect((err as Error).message).toMatch(/Another sdkvm operation/);
    }
    // 提示给的是实际锁路径（SDKVM_HOME 自定义时不再是写死的 ~/.sdkvm/.lock）
    expect(hint).toContain(path.join(home, '.lock'));
  });

  it('withLock releases on success and on throw', async () => {
    const { withLock, acquireLock, releaseLock } = await freshLock();
    await withLock(async () => 1);
    acquireLock();
    releaseLock();
    await expect(
      withLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    acquireLock(); // 上一次抛错后锁已释放
    releaseLock();
  });

  it('withLock waits for a live holder to release (bounded)', async () => {
    const { withLock, acquireLock, releaseLock } = await freshLock();
    // 他人持锁（活进程 + 新鲜 mtime）
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    fs.mkdirSync(path.join(home, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lock', 'info.json'), JSON.stringify({ pid: child.pid }));
    // 300ms 后持有者自行消失：withLock 应当等到并取得锁
    const timer = setTimeout(() => {
      fs.rmSync(path.join(home, '.lock'), { recursive: true, force: true });
    }, 300);
    const ran = await withLock(async () => 'ran', { waitMs: 5_000 });
    clearTimeout(timer);
    expect(ran).toBe('ran');
    releaseLock();
    child.kill();
  });

  it('withLock gives up with LockBusyError after waitMs', async () => {
    const { withLock } = await freshLock();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    fs.mkdirSync(path.join(home, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lock', 'info.json'), JSON.stringify({ pid: child.pid }));
    const started = Date.now();
    await expect(withLock(async () => 1, { waitMs: 400 })).rejects.toThrow(/Another sdkvm operation/);
    // 确实等过，而不是立刻失败
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    child.kill();
  });

  it('writes holder info.json on acquire', async () => {
    const { acquireLock, releaseLock } = await freshLock();
    acquireLock();
    const raw = JSON.parse(
      fs.readFileSync(path.join(home, '.lock', 'info.json'), 'utf8'),
    ) as { pid?: number };
    expect(raw.pid).toBe(process.pid);
    releaseLock();
  });

  it('steals a lock whose dir mtime is past STALE_MS', async () => {
    const { acquireLock, releaseLock } = await freshLock();
    // 伪造一个"存活进程持有、但心跳停了很久"的锁：pid 活着走 mtime 判定
    fs.mkdirSync(path.join(home, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lock', 'info.json'), JSON.stringify({ pid: process.pid }));
    const past = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(path.join(home, '.lock'), past, past);
    expect(() => acquireLock()).not.toThrow();
    releaseLock();
  });

  it('treats EPERM as holder-alive and does not steal', async () => {
    const { acquireLock, releaseLock } = await freshLock();
    acquireLock();
    releaseLock();
    // 重新手工放一个"他人持锁"的锁：本进程 heldDepth 为 0，走真实探测路径
    fs.mkdirSync(path.join(home, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lock', 'info.json'), JSON.stringify({ pid: 999999 }));
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(
      (() => {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      }) as unknown as typeof process.kill,
    );
    expect(() => acquireLock()).toThrow(/Another sdkvm operation/);
    expect(killSpy).toHaveBeenCalled();
  });

  it('steals the lock when the holder process is dead', async () => {
    const { acquireLock, releaseLock } = await freshLock();
    const child = spawn(process.execPath, ['-e', '']);
    const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? 0)));
    expect(code).toBe(0);
    fs.mkdirSync(path.join(home, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lock', 'info.json'), JSON.stringify({ pid: child.pid }));
    expect(() => acquireLock()).not.toThrow();
    releaseLock();
  });

  it('releaseLock (rename-claim) will not delete a lock stolen and re-held by another pid', async () => {
    const { acquireLock, releaseLock } = await freshLock();
    acquireLock();
    // 模拟锁被偷走：我们的锁目录被挪走，新持有者（别的 pid）已经重建
    fs.renameSync(path.join(home, '.lock'), path.join(home, `.lock.stale-${process.pid}`));
    fs.mkdirSync(path.join(home, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lock', 'info.json'), JSON.stringify({ pid: 424242 }));
    releaseLock();
    // 新持有者的锁原样保留
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.lock', 'info.json'), 'utf8')) as { pid?: number };
    expect(raw.pid).toBe(424242);
  });

  it('stale steal clears a leftover .lock.stale-<pid> staging dir (pid reuse)', async () => {
    const { acquireLock, releaseLock } = await freshLock();
    // 持有者已死 + 本 pid 名下残留 staging（上次偷锁后进程死在 rename 与 rm 之间）：
    // rename 目标非空会持续 ENOTEMPTY，绝不能因此无限重试
    fs.mkdirSync(path.join(home, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lock', 'info.json'), JSON.stringify({ pid: 999999 }));
    const staging = path.join(home, `.lock.stale-${process.pid}`);
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'info.json'), '{}');
    const past = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(path.join(home, '.lock'), past, past);
    expect(() => acquireLock()).not.toThrow();
    expect(fs.existsSync(staging)).toBe(false);
    expect(fs.existsSync(path.join(home, '.lock'))).toBe(true);
    releaseLock();
  });

  it('sweeps dead-pid .lock.stale-* leftovers while holding the lock', async () => {
    const { acquireLock, releaseLock } = await freshLock();
    fs.mkdirSync(path.join(home, '.lock'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lock', 'info.json'), JSON.stringify({ pid: 999999 }));
    const deadStaging = path.join(home, '.lock.stale-999999');
    fs.mkdirSync(deadStaging, { recursive: true });
    // 重新获取（正常路径）时应顺手清掉死 pid 的残留
    const past = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(path.join(home, '.lock'), past, past);
    acquireLock();
    expect(fs.existsSync(deadStaging)).toBe(false);
    releaseLock();
  });

  it('isProcessAlive: dead pid false, own pid true', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999999)).toBe(false);
  });
});
