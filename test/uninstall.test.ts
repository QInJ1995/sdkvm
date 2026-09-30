import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uninstallCommand } from '../src/cli/uninstall.js';
import { currentSdk } from '../src/core/registry.js';
import { detectPlatform } from '../src/core/platform.js';
import { setCurrent, clearCurrent } from '../src/fs/link.js';
import { SdkvmError } from '../src/util/errors.js';
import { rcBegin, upsertRcContent } from '../src/shell/rc.js';

let home: string;
let userHome: string;
let realHome: string;
let realShell: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-uninstall-'));
  userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-uninstall-user-'));
  process.env.SDKVM_HOME = home;
  realHome = process.env.HOME ?? '';
  realShell = process.env.SHELL;
  process.env.HOME = userHome;
  process.env.SHELL = '/bin/zsh';
});

afterEach(() => {
  process.env.HOME = realHome;
  if (realShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = realShell;
  delete process.env.SDKVM_HOME;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(userHome, { recursive: true, force: true });
});

// 本组断言 POSIX rc 语义；Windows 上 uninstallCommand 走注册表分支
// （还会真实修改运行用户的注册表），Windows 真实链路由 CI 的 e2e job 覆盖
describe.skipIf(process.platform === 'win32')('uninstall 当前版本', () => {
  it('删除目录、清除 current 链接并移除 rc 标记块', async () => {
    const dir = path.join(home, 'jdks', 'temurin-21.0.5+11');
    const javaHome = path.join(dir, 'Contents', 'Home');
    fs.mkdirSync(javaHome, { recursive: true });
    setCurrent('java', javaHome, detectPlatform());
    expect(currentSdk('java')?.dirPath).toBe(dir);

    const rc = path.join(userHome, '.zshrc');
    fs.writeFileSync(rc, upsertRcContent('export A=1\n', 'java'));

    await uninstallCommand('java', '21', {});

    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(home, 'current-java'))).toBe(false);
    const after = fs.readFileSync(rc, 'utf8');
    expect(after).not.toContain(rcBegin('java'));
    expect(after).toContain('export A=1');
  });

  it('卸载非当前版本不动 rc 与链接', async () => {
    const dir = path.join(home, 'jdks', 'zulu-21.0.5');
    const javaHome = path.join(dir, 'Contents', 'Home');
    fs.mkdirSync(javaHome, { recursive: true });
    const other = path.join(home, 'jdks', 'temurin-21.0.12.1+1');
    fs.mkdirSync(path.join(other, 'Contents', 'Home'), { recursive: true });
    setCurrent('java', path.join(other, 'Contents', 'Home'), detectPlatform());

    const rc = path.join(userHome, '.zshrc');
    fs.writeFileSync(rc, upsertRcContent('export A=1\n', 'java'));

    await uninstallCommand('java', 'zulu-21', {});

    expect(fs.existsSync(dir)).toBe(false);
    expect(currentSdk('java')?.dirPath).toBe(other);
    expect(fs.readFileSync(rc, 'utf8')).toContain(rcBegin('java'));
  });
});

describe('current 链接位置被真实目录占用', () => {
  it('setCurrent 拒绝并给出可读错误，而不是裸 EISDIR', () => {
    const real = path.join(home, 'current-java');
    fs.mkdirSync(real, { recursive: true });
    expect(() => setCurrent('java', '/some/target', detectPlatform())).toThrow(SdkvmError);
    expect(() => setCurrent('java', '/some/target', detectPlatform())).toThrow(/real directory/);
    // 目录原样保留，绝不被删
    expect(fs.existsSync(real)).toBe(true);
  });

  it('clearCurrent 跳过并保留目录，不做递归删除', () => {
    const real = path.join(home, 'current-java');
    fs.mkdirSync(path.join(real, 'user-file'), { recursive: true });
    fs.writeFileSync(path.join(real, 'user-file', 'data.txt'), 'keep');
    clearCurrent('java');
    expect(fs.readFileSync(path.join(real, 'user-file', 'data.txt'), 'utf8')).toBe('keep');
  });
});
