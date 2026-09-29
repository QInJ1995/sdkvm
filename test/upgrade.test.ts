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
  it('only deletes bak after successful package.json presence and restores on failure', () => {
    const body = windowsUpgradeScript('C:\\sdkvm');
    expect(body).toContain('if exist "%HOME%\\cli\\package.json"');
    expect(body).toContain('move /y "%HOME%\\cli.bak" "%HOME%\\cli"');
    // 成功分支里才删 bak；失败分支不无条件 rmdir bak
    const successBlock = body.slice(body.indexOf('if exist "%HOME%\\cli\\package.json"'));
    expect(successBlock).toMatch(/package\.json[\s\S]*rmdir \/s \/q "%HOME%\\cli\.bak"/);
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

describe('windowsUpgradeScript home 校验', () => {
  it('拒绝含 cmd 元字符的 home', () => {
    expect(() => windowsUpgradeScript('C:\\sd"kvm')).toThrow(/batch/);
    expect(() => windowsUpgradeScript('C:\\sd&kvm')).toThrow(/batch/);
    expect(() => windowsUpgradeScript('C:\\sd%kvm')).toThrow(/batch/);
    expect(() => windowsUpgradeScript('C:\\sd^kvm')).toThrow(/batch/);
  });
});

describe('windowsUpgradeScript 控制字符校验', () => {
  it('拒绝含换行/回车的 home（会提前终结 set 行）', () => {
    expect(() => windowsUpgradeScript('C:\\sd\nkvm')).toThrow(/batch/);
    expect(() => windowsUpgradeScript('C:\\sd\rkvm')).toThrow(/batch/);
  });
});
