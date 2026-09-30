import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverInterruptedInstalls, sweepStaleParts, sweepStaleTmp } from '../src/cli/install.js';
import { detectPlatform } from '../src/core/platform.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-install-'));
  process.env.SDKVM_HOME = home;
});

afterEach(() => {
  delete process.env.SDKVM_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

/** 在 go 的安装根下摆一个目录及其伴随文件 */
function goDir(name: string): string {
  const dir = path.join(home, 'gos', name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMarker(finalDir: string, body: string): string {
  const marker = `${finalDir}.incomplete`;
  fs.writeFileSync(marker, body);
  return marker;
}

describe('recoverInterruptedInstalls', () => {
  it('标记 replacing:true 且无 bak：换位从未发生，完好目录保留、只清标记', () => {
    const dir = goDir('golang-1.24.5');
    fs.writeFileSync(path.join(dir, 'go.bin'), 'good');
    const marker = writeMarker(dir, JSON.stringify({ startedAt: 1, replacing: true }));

    recoverInterruptedInstalls('go');

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'go.bin'), 'utf8')).toBe('good');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('标记 replacing:false 且无 bak：半成品被删除，标记清掉', () => {
    const dir = goDir('golang-1.23.4');
    const marker = writeMarker(dir, JSON.stringify({ startedAt: 1, replacing: false }));

    recoverInterruptedInstalls('go');

    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('标记 + bak：删半成品并把 bak 恢复回 finalDir', () => {
    const dir = goDir('golang-1.24.5');
    fs.writeFileSync(path.join(dir, 'half'), 'broken');
    const bak = goDir('golang-1.24.5.bak');
    fs.writeFileSync(path.join(bak, 'go.bin'), 'good');
    writeMarker(dir, JSON.stringify({ startedAt: 1, replacing: true }));

    recoverInterruptedInstalls('go');

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'go.bin'), 'utf8')).toBe('good');
    expect(fs.existsSync(bak)).toBe(false);
    expect(fs.existsSync(`${dir}.incomplete`)).toBe(false);
  });

  it('孤儿 bak（无标记、无 finalDir）：换回 finalDir', () => {
    const bak = goDir('golang-1.25.1.bak');
    fs.writeFileSync(path.join(bak, 'go.bin'), 'good');

    recoverInterruptedInstalls('go');

    expect(fs.existsSync(path.join(home, 'gos', 'golang-1.25.1'))).toBe(true);
    expect(fs.existsSync(bak)).toBe(false);
  });

  it('bak 与 finalDir 并存（上次换位成功、bak 清理失败）：两者都不动', () => {
    const dir = goDir('golang-1.24.5');
    fs.writeFileSync(path.join(dir, 'go.bin'), 'new');
    const bak = goDir('golang-1.24.5.bak');
    fs.writeFileSync(path.join(bak, 'go.bin'), 'old');

    recoverInterruptedInstalls('go');

    expect(fs.readFileSync(path.join(dir, 'go.bin'), 'utf8')).toBe('new');
    expect(fs.existsSync(bak)).toBe(true);
  });

  it('旧格式标记（纯时间戳）无法判断语义：保守保留目录、只清标记', () => {
    const dir = goDir('golang-1.24.5');
    fs.writeFileSync(path.join(dir, 'go.bin'), 'good');
    const marker = writeMarker(dir, '1717000000000');

    recoverInterruptedInstalls('go');

    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('该类型还没有安装目录时是安全 no-op', () => {
    expect(() => recoverInterruptedInstalls('python')).not.toThrow();
  });
});

describe('sweepStaleParts', () => {
  function cacheFile(name: string): string {
    const dir = path.join(home, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x');
    return file;
  }

  it('按龄清扫：过期 .part 删除、活跃 .part 保留', () => {
    const stale = cacheFile('go1.24.5.tgz.tmp-111.part');
    const fresh = cacheFile('go1.25.1.tgz.tmp-222.part');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);

    sweepStaleParts();

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('非 .part 的 cache 文件不参与清扫', () => {
    const other = cacheFile('sdkvm.tgz');
    const old = new Date(0);
    fs.utimesSync(other, old, old);

    sweepStaleParts();

    expect(fs.existsSync(other)).toBe(true);
  });
});

describe('recoverInterruptedInstalls 标记的 mode/settled 语义', () => {
  it('settled 标记：finalDir 完好保留，标记与 bak 只清不回滚', () => {
    const dir = goDir('golang-1.24.5');
    fs.writeFileSync(path.join(dir, 'go.bin'), 'good');
    const bak = goDir('golang-1.24.5.bak');
    fs.writeFileSync(path.join(bak, 'go.bin'), 'old');
    const marker = writeMarker(
      dir,
      JSON.stringify({ startedAt: 1, replacing: true, mode: 'archive', settled: true }),
    );

    recoverInterruptedInstalls('go');

    expect(fs.readFileSync(path.join(dir, 'go.bin'), 'utf8')).toBe('good');
    expect(fs.existsSync(bak)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('archive 模式 + bak + finalDir 并存：换位是原子 rename，保留新装、丢 bak', () => {
    const dir = goDir('golang-1.24.5');
    fs.writeFileSync(path.join(dir, 'go.bin'), 'new');
    const bak = goDir('golang-1.24.5.bak');
    fs.writeFileSync(path.join(bak, 'go.bin'), 'old');
    writeMarker(dir, JSON.stringify({ startedAt: 1, replacing: true, mode: 'archive' }));

    recoverInterruptedInstalls('go');

    expect(fs.readFileSync(path.join(dir, 'go.bin'), 'utf8')).toBe('new');
    expect(fs.existsSync(bak)).toBe(false);
    expect(fs.existsSync(`${dir}.incomplete`)).toBe(false);
  });

  it('installer 模式 + 可执行文件已就位：保留新装、丢 bak', () => {
    const dir = goDir('golang-1.24.5');
    const binName = detectPlatform().os === 'windows' ? 'go.exe' : 'go';
    const bin = path.join(dir, 'bin', binName);
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, 'new');
    const bak = goDir('golang-1.24.5.bak');
    fs.writeFileSync(path.join(bak, 'go.bin'), 'old');
    writeMarker(dir, JSON.stringify({ startedAt: 1, replacing: true, mode: 'installer' }));

    recoverInterruptedInstalls('go');

    expect(fs.readFileSync(bin, 'utf8')).toBe('new');
    expect(fs.existsSync(bak)).toBe(false);
    expect(fs.existsSync(`${dir}.incomplete`)).toBe(false);
  });

  it('installer 模式 + bak + finalDir 并存：安装器直接写目录没有原子性，仍回滚旧版', () => {
    const dir = goDir('golang-1.24.5');
    fs.writeFileSync(path.join(dir, 'half'), 'broken');
    const bak = goDir('golang-1.24.5.bak');
    fs.writeFileSync(path.join(bak, 'go.bin'), 'good');
    writeMarker(dir, JSON.stringify({ startedAt: 1, replacing: true, mode: 'installer' }));

    recoverInterruptedInstalls('go');

    expect(fs.readFileSync(path.join(dir, 'go.bin'), 'utf8')).toBe('good');
    expect(fs.existsSync(bak)).toBe(false);
  });
});

describe('sweepStaleTmp', () => {
  /** 同步跑完一个即刻退出的子进程：pid 已被 wait 回收，必然已死（跨平台、无竞态） */
  function reapedPid(): number {
    const out = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    const pid = Number(out.toString().trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`unexpected child pid output: ${out}`);
    return pid;
  }

  /** 在 tmp/ 下摆一个带载荷的目录（文件/目录对清扫逻辑等价，目录覆盖面更大） */
  function tmpEntry(name: string, old = false): string {
    const dir = path.join(home, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'payload'), 'x');
    if (old) {
      const t = new Date(Date.now() - 3 * 60 * 60 * 1000);
      fs.utimesSync(p, t, t);
    }
    return p;
  }

  it('死 pid 的归档残留（.pid / .pid.part 结尾）不论新旧立即清', () => {
    const dead = reapedPid();
    const fresh = tmpEntry(`node-v22.20.0-darwin-x64.tar.gz.${dead}`);
    const freshPart = tmpEntry(`node-v22.20.0-darwin-x64.tar.gz.${dead}.part`);
    sweepStaleTmp();
    expect(fs.existsSync(fresh)).toBe(false);
    expect(fs.existsSync(freshPart)).toBe(false);
  });

  it('活 pid 的残留即使超过按龄阈值也不动', () => {
    const mine = tmpEntry(`node-v22.20.0-darwin-x64.tar.gz.${process.pid}`, true);
    sweepStaleTmp();
    expect(fs.existsSync(mine)).toBe(true);
  });

  it('extract-<ts>-<pid> 解压目录同样按 pid 判断：死的清、活的留', () => {
    const dead = tmpEntry(`extract-1717000000000-${reapedPid()}`);
    const live = tmpEntry(`extract-1717000000001-${process.pid}`, true);
    sweepStaleTmp();
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('解析不出 pid 的条目退回按龄：过期的清、新的留', () => {
    const stale = tmpEntry('orphan-old', true);
    const fresh = tmpEntry('orphan-new');
    sweepStaleTmp();
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });
});
