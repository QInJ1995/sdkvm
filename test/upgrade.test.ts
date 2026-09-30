import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checksumFor, isScriptInstall, replaceCliPackage, windowsUpgradeScript } from '../src/cli/upgrade.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-upgrade-'));
  process.env.SDKVM_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.SDKVM_HOME;
});

describe('upgrade install method', () => {
  it('npm layout is not a script install', () => {
    expect(
      isScriptInstall({
        home,
        packageRoot: '/usr/lib/node_modules/sdkvm',
        execPath: '/usr/bin/node',
      }),
    ).toBe(false);
  });

  it('detects package root under home/cli', () => {
    expect(
      isScriptInstall({
        home,
        packageRoot: path.join(home, 'cli'),
        execPath: '/usr/bin/node',
      }),
    ).toBe(true);
  });

  it('detects execPath under home/runtime', () => {
    expect(
      isScriptInstall({
        home,
        packageRoot: '/usr/lib/node_modules/sdkvm',
        execPath: path.join(home, 'runtime', 'current', 'bin', 'node'),
      }),
    ).toBe(true);
  });

  it('ignores a leftover cli directory when the process is npm', () => {
    fs.mkdirSync(path.join(home, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cli', 'package.json'), '{"version":"1.0.0"}\n');
    expect(
      isScriptInstall({
        home,
        packageRoot: '/usr/lib/node_modules/sdkvm',
        execPath: '/usr/bin/node',
      }),
    ).toBe(false);
  });
});

describe('checksumFor', () => {
  it('reads the hash for a named asset', () => {
    const text = [
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  sdkvm-1.0.0.tgz',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *sdkvm.tgz',
    ].join('\n');
    expect(checksumFor(text, 'sdkvm.tgz')).toBe('b'.repeat(64));
    expect(checksumFor(text, 'missing.tgz')).toBeNull();
  });
});

describe('windowsUpgradeScript', () => {
  it('derives HOME from the script location, not an embedded path', () => {
    const body = windowsUpgradeScript();
    // %~dp0 推导：中文/空格/cmd 元字符路径都能工作，也不再有"无法嵌入"的拒绝分支
    expect(body).toContain('for %%i in ("%~dp0.") do set "HOME=%%~fi"');
    expect(body).not.toMatch(/set "HOME=[A-Z]:/);
    // 等待用 ping 而非 timeout：timeout /t 在 stdin 被重定向（spawn stdio ignore）时立即报错
    expect(body).toContain('ping -n 3 127.0.0.1 >nul');
    expect(body).not.toContain('timeout /t');
  });

  it('only deletes bak after successful package.json presence and restores on failure', () => {
    const body = windowsUpgradeScript();
    // 换位成功校验：package.json 不在则走回滚
    expect(body).toContain('if not exist "%HOME%\\cli\\package.json" goto :rollback');
    // 回滚只在 bak 存在时清 cli（bak 不在 = 换位从未开始，cli 是完好旧版本）
    expect(body).toContain('move /y "%HOME%\\cli.bak" "%HOME%\\cli"');
    // 第一步 move 重试后仍失败（cli 未移走）绝不把 package move 进现存的 cli
    expect(body).toContain('if "%MOVED%"=="0" goto :rollback');
    expect(body).toContain('if exist "%HOME%\\cli" goto :rollback');
    // 成功路径（rollback 标签之前）才清理 bak 与 cli.next；
    // indexOf 会先命中 goto :rollback 那行（在 package.json 门槛之前），必须取标签本身
    const rollbackAt = body.lastIndexOf(':rollback');
    const successBlock = body.slice(0, rollbackAt);
    expect(successBlock).toMatch(/package\.json[\s\S]*rmdir \/s \/q "%HOME%\\cli\.bak"/);
  });

  it('keeps the script on disk when rollback itself fails', () => {
    const body = windowsUpgradeScript();
    const failAt = body.lastIndexOf(':rollbackfail');
    expect(failAt).toBeGreaterThan(0);
    const tail = body.slice(failAt);
    expect(tail).toContain('exit /b 2');
    expect(tail).not.toContain('del "%~f0"');
  });
});

describe('replaceCliPackage', () => {
  it('replaces cli and leaves runtime in place', async () => {
    const runtime = path.join(home, 'runtime', 'current');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'marker'), 'keep');
    fs.mkdirSync(path.join(home, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cli', 'package.json'), '{"version":"0.0.1"}\n');

    const stage = path.join(home, 'stage', 'package');
    fs.mkdirSync(path.join(stage, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'package.json'), '{"version":"1.2.3"}\n');
    fs.writeFileSync(path.join(stage, 'dist', 'index.js'), 'console.log(1)\n');
    const archive = path.join(home, 'sdkvm.tgz');
    execFileSync('tar', ['-czf', archive, '-C', path.join(home, 'stage'), 'package']);

    await replaceCliPackage(archive, home);
    expect(fs.readFileSync(path.join(home, 'cli', 'package.json'), 'utf8')).toContain('1.2.3');
    expect(fs.readFileSync(path.join(runtime, 'marker'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(home, 'cli.next'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'cli.bak'))).toBe(false);
  });

  it('rejects an archive without package/package.json and keeps the old cli', async () => {
    fs.mkdirSync(path.join(home, 'cli'), { recursive: true });
    fs.writeFileSync(path.join(home, 'cli', 'package.json'), '{"version":"0.0.1"}\n');
    const stage = path.join(home, 'stage', 'other');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'readme.txt'), 'nope\n');
    const archive = path.join(home, 'bad.tgz');
    execFileSync('tar', ['-czf', archive, '-C', path.join(home, 'stage'), 'other']);

    await expect(replaceCliPackage(archive, home)).rejects.toThrow(/missing package\/package\.json/);
    expect(fs.readFileSync(path.join(home, 'cli', 'package.json'), 'utf8')).toContain('0.0.1');
    expect(fs.existsSync(path.join(home, 'cli.next'))).toBe(false);
  });
});

