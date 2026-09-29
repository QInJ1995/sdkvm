import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLock, releaseLock, withLock } from '../src/core/lock.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-lock-'));
  process.env.SDKVM_HOME = home;
});

afterEach(() => {
  releaseLock();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.SDKVM_HOME;
  vi.restoreAllMocks();
});

describe('lock', () => {
  it('second acquire while held throws', () => {
    acquireLock();
    expect(() => acquireLock()).toThrow(/Another sdkvm operation/);
  });

  it('withLock releases on success and on throw', async () => {
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

  it('writes holder info.json on acquire', () => {
    acquireLock();
    const raw = JSON.parse(
      fs.readFileSync(path.join(home, '.lock', 'info.json'), 'utf8'),
    ) as { pid?: number };
    expect(raw.pid).toBe(process.pid);
  });

  it('steals a lock whose dir mtime is past STALE_MS', () => {
    acquireLock();
    const past = new Date(Date.now() - 6 * 60 * 1000);
    fs.utimesSync(path.join(home, '.lock'), past, past);
    expect(() => acquireLock()).not.toThrow();
  });

  it('treats EPERM as holder-alive and does not steal', () => {
    acquireLock();
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
    acquireLock();
    const child = spawn(process.execPath, ['-e', '']);
    const code = await new Promise<number>((r) => child.on('exit', (c) => r(c ?? 0)));
    expect(code).toBe(0);
    fs.writeFileSync(path.join(home, '.lock', 'info.json'), JSON.stringify({ pid: child.pid }));
    expect(() => acquireLock()).not.toThrow();
  });

  it('stale steal clears a leftover .lock.stale-<pid> staging dir (pid reuse)', () => {
    // 持有者已死 + 本 pid 名下残留 staging（上次偷锁后进程死在 rename 与 rm 之间）：
    // rename 目标非空会持续 ENOTEMPTY，绝不能因此无限重试
    acquireLock();
    releaseLock();
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
  });

  it('sweeps dead-pid .lock.stale-* leftovers while holding the lock', () => {
    acquireLock();
    const deadStaging = path.join(home, '.lock.stale-999999');
    fs.mkdirSync(deadStaging, { recursive: true });
    releaseLock();
    // 重新获取（正常路径）时应顺手清掉死 pid 的残留
    acquireLock();
    expect(fs.existsSync(deadStaging)).toBe(false);
  });
});
