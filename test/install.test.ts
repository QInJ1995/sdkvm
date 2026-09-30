import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recoverInterruptedInstalls, sweepStaleParts } from '../src/cli/install.js';

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
