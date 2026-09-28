import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uninstallCommand } from '../src/cli/uninstall.js';
import { currentSdk } from '../src/core/registry.js';
import { detectPlatform } from '../src/core/platform.js';
import { setCurrent } from '../src/fs/link.js';
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

describe('uninstall 当前版本', () => {
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
