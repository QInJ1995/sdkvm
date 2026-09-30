import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uninstallCommand } from '../src/cli/uninstall.js';
import { useCommand } from '../src/cli/use.js';
import { rcBegin } from '../src/shell/rc.js';

let fakeHome: string;
let sdkHome: string;
let realHomePath: string;
let stamps: Map<string, string>;
let realShell: string | undefined;
let realJavaHome: string | undefined;
let realSdkvmHome: string | undefined;

function stamp(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

function realRcFiles(home: string): string[] {
  return [
    path.join(home, '.zshrc'),
    path.join(home, '.bashrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.profile'),
    path.join(home, '.config', 'fish', 'config.fish'),
  ];
}

function installJava(root: string): void {
  fs.mkdirSync(path.join(root, 'jdks', 'temurin-21', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'jdks', 'temurin-21', 'bin', 'java'), '');
}

function installMaven(root: string): void {
  fs.mkdirSync(path.join(root, 'mavens', 'maven-3.9.9', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'mavens', 'maven-3.9.9', 'bin', 'mvn'), '');
}

describe.skipIf(process.platform === 'win32')('useCommand 写入 shell rc', () => {
  beforeEach(() => {
    realHomePath = os.homedir();
    stamps = new Map(realRcFiles(realHomePath).map((file) => [file, stamp(file)]));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-use-home-'));
    sdkHome = path.join(fakeHome, 'sdk!vm');
    fs.mkdirSync(sdkHome, { recursive: true });
    realShell = process.env.SHELL;
    realJavaHome = process.env.JAVA_HOME;
    realSdkvmHome = process.env.SDKVM_HOME;
    process.env.SDKVM_HOME = sdkHome;
    delete process.env.JAVA_HOME;
    process.exitCode = undefined;
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(() => {
    try {
      for (const [file, before] of stamps) {
        expect(stamp(file), file).toBe(before);
      }
    } finally {
      vi.restoreAllMocks();
      process.exitCode = undefined;
      if (realShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = realShell;
      if (realJavaHome === undefined) delete process.env.JAVA_HOME;
      else process.env.JAVA_HOME = realJavaHome;
      if (realSdkvmHome === undefined) delete process.env.SDKVM_HOME;
      else process.env.SDKVM_HOME = realSdkvmHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('fish 写入 config.fish，重复 use 只有一块，且不写 bash 语法', async () => {
    process.env.SHELL = '/usr/local/bin/fish';
    installJava(sdkHome);
    await useCommand('java', '21', {});
    await useCommand('java', '21', {});

    const rc = path.join(fakeHome, '.config', 'fish', 'config.fish');
    const text = fs.readFileSync(rc, 'utf8');
    expect(text).toContain('set -gx JAVA_HOME');
    expect(text).toContain("sdk!vm/current-java");
    expect(text).toContain('fish_add_path -p "$JAVA_HOME/bin"');
    expect(text).not.toContain('export JAVA_HOME');
    expect(text).not.toContain('case ":$PATH:"');
    expect(text.split(rcBegin('java')).length - 1).toBe(1);
    expect(fs.existsSync(path.join(fakeHome, '.zshrc'))).toBe(false);
    expect(fs.lstatSync(path.join(sdkHome, 'current-java')).isSymbolicLink()).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('zsh 把含 ! 的路径写成单引号字面量', async () => {
    process.env.SHELL = '/bin/zsh';
    installJava(sdkHome);
    await useCommand('java', '21', {});

    const text = fs.readFileSync(path.join(fakeHome, '.zshrc'), 'utf8');
    expect(text).toMatch(/export JAVA_HOME='[^']*sdk!vm\/current-java'/);
    expect(text).not.toContain('export JAVA_HOME="$HOME');
    expect(fs.existsSync(path.join(fakeHome, '.config', 'fish', 'config.fish'))).toBe(false);
  });

  it('认不出的 shell 不创建 rc，current 链接仍然切过去', async () => {
    process.env.SHELL = '/bin/dash';
    installJava(sdkHome);
    await useCommand('java', '21', {});

    for (const file of realRcFiles(fakeHome)) {
      expect(fs.existsSync(file), file).toBe(false);
    }
    expect(fs.lstatSync(path.join(sdkHome, 'current-java')).isSymbolicLink()).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('rc 写失败时退出码为 1，链接已经切过去', async () => {
    process.env.SHELL = '/bin/zsh';
    installJava(sdkHome);
    fs.mkdirSync(path.join(fakeHome, '.zshrc'));
    await useCommand('java', '21', {});

    expect(process.exitCode).toBe(1);
    expect(fs.lstatSync(path.join(sdkHome, 'current-java')).isSymbolicLink()).toBe(true);
    expect(fs.statSync(path.join(fakeHome, '.zshrc')).isDirectory()).toBe(true);
  });

  it('maven 在 rc 没有 java 块且没有 JAVA_HOME 时提示需要 JDK', async () => {
    process.env.SHELL = '/bin/zsh';
    installMaven(sdkHome);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    await useCommand('maven', '3.9.9', {});
    expect(errors.some((line) => line.includes('needs a JDK'))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('rc 里已有 java 块时，maven 不再提示缺 JDK', async () => {
    process.env.SHELL = '/bin/zsh';
    installJava(sdkHome);
    installMaven(sdkHome);
    await useCommand('java', '21', {});
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    await useCommand('maven', '3.9.9', {});
    expect(errors.some((line) => line.includes('needs a JDK'))).toBe(false);
  });

  it('fish 下 use 的块，换成 zsh 卸载时仍会被清掉', async () => {
    process.env.SHELL = '/usr/local/bin/fish';
    installJava(sdkHome);
    await useCommand('java', '21', {});
    const rc = path.join(fakeHome, '.config', 'fish', 'config.fish');
    fs.appendFileSync(rc, 'set -gx USER_STUFF 1\n');

    process.env.SHELL = '/bin/zsh';
    await uninstallCommand('java', '21', {});

    const text = fs.readFileSync(rc, 'utf8');
    expect(text).not.toContain(rcBegin('java'));
    expect(text).toContain('set -gx USER_STUFF 1');
    expect(fs.existsSync(path.join(sdkHome, 'current-java'))).toBe(false);
    expect(fs.existsSync(path.join(sdkHome, 'jdks', 'temurin-21'))).toBe(false);
  });
});
