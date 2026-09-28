import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installUseHint, refinedUseHint } from '../src/cli/install.js';
import { findInstalled, listInstalled } from '../src/core/registry.js';
import {
  parseFlutterVersion,
  parseMavenVersion,
  parseNodeVersion,
  parsePythonVersion,
  parseVersion,
} from '../src/core/version.js';
import { SdkvmError } from '../src/util/errors.js';

let home: string;

function mkJdk(dirName: string): void {
  fs.mkdirSync(path.join(home, 'jdks', dirName), { recursive: true });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'sdkvm-registry-'));
  process.env.SDKVM_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.SDKVM_HOME;
});

describe('registry', () => {
  it('lists and sorts installed', () => {
    mkJdk('temurin-21.0.5+11');
    mkJdk('zulu-21.0.12.1');
    mkJdk('temurin-17.0.13+11');
    const list = listInstalled('java');
    expect(list.map((j) => j.version.major)).toEqual([17, 21, 21]);
    expect(list[0]?.version.vendor).toBe('temurin');
  });

  it('ignores non-jdk dirs', () => {
    mkJdk('temurin-21.0.5+11');
    fs.mkdirSync(path.join(home, 'jdks', 'random'));
    expect(listInstalled('java')).toHaveLength(1);
  });

  it('major match picks highest across vendors', () => {
    mkJdk('temurin-21.0.5+11');
    mkJdk('zulu-21.0.12.1');
    expect(findInstalled('java', '21').dirPath.endsWith('zulu-21.0.12.1')).toBe(true);
  });

  it('vendor prefix match', () => {
    mkJdk('temurin-21.0.5+11');
    mkJdk('zulu-21.0.12.1');
    expect(findInstalled('java', 'temurin-21').dirPath.endsWith('temurin-21.0.5+11')).toBe(true);
  });

  it('full prefix match ignores build', () => {
    mkJdk('temurin-21.0.5+11');
    expect(findInstalled('java', '21.0.5').dirPath.endsWith('temurin-21.0.5+11')).toBe(true);
  });

  it('lts match', () => {
    mkJdk('temurin-21.0.5+11');
    mkJdk('temurin-22.0.1+2');
    expect(findInstalled('java', 'lts').version.major).toBe(21);
  });

  it('node lts matches even majors that have entered LTS, not a Current even major', () => {
    fs.mkdirSync(path.join(home, 'nodes', 'nodejs-22.20.0'), { recursive: true });
    fs.mkdirSync(path.join(home, 'nodes', 'nodejs-21.0.0'), { recursive: true });
    fs.mkdirSync(path.join(home, 'nodes', 'nodejs-24.2.0'), { recursive: true });
    fs.mkdirSync(path.join(home, 'nodes', 'nodejs-26.1.0'), { recursive: true });
    vi.useFakeTimers();
    try {
      // 2026-09：26 仍是 Current（10 月才进 LTS），24 已经是 LTS
      vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
      expect(findInstalled('node', 'lts').dirPath.endsWith('nodejs-24.2.0')).toBe(true);
      vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
      expect(findInstalled('node', 'lts').dirPath.endsWith('nodejs-26.1.0')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('go lts is rejected', () => {
    expect(() => findInstalled('go', 'lts')).toThrow(SdkvmError);
  });

  it('miniconda full spec matches python pin and build pin', () => {
    const root = path.join(home, 'minicondas');
    fs.mkdirSync(path.join(root, 'miniconda-py313_26.7.1-1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'miniconda-py313_26.7.1-2'), { recursive: true });
    fs.mkdirSync(path.join(root, 'miniconda-py314_26.7.1-1'), { recursive: true });
    expect(findInstalled('miniconda', 'py313').dirPath.endsWith('miniconda-py313_26.7.1-2')).toBe(true);
    expect(findInstalled('miniconda', '26.7.1-1').dirPath.endsWith('miniconda-py314_26.7.1-1')).toBe(true);
    expect(findInstalled('miniconda', 'py313_26.7.1-1').dirPath.endsWith('miniconda-py313_26.7.1-1')).toBe(true);
    expect(findInstalled('miniconda', '26.7').dirPath.endsWith('miniconda-py314_26.7.1-1')).toBe(true);
    expect(findInstalled('miniconda', '26').dirPath.endsWith('miniconda-py314_26.7.1-1')).toBe(true);
  });

  it('python loose specs skip an installed prerelease', () => {
    const root = path.join(home, 'pythons');
    fs.mkdirSync(path.join(root, 'cpython-3.12.7'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cpython-3.14.0rc2'), { recursive: true });
    expect(findInstalled('python', 'latest').dirPath.endsWith('cpython-3.12.7')).toBe(true);
    expect(findInstalled('python', '3').dirPath.endsWith('cpython-3.12.7')).toBe(true);
    expect(findInstalled('python', '3.12').dirPath.endsWith('cpython-3.12.7')).toBe(true);
    expect(findInstalled('python', '3.14.0rc2').dirPath.endsWith('cpython-3.14.0rc2')).toBe(true);
    expect(() => findInstalled('python', '3.14')).toThrow(SdkvmError);
  });

  it('maven and flutter loose specs skip an installed prerelease', () => {
    fs.mkdirSync(path.join(home, 'mavens', 'maven-4.0.0'), { recursive: true });
    fs.mkdirSync(path.join(home, 'mavens', 'maven-4.0.0-rc-4'), { recursive: true });
    fs.mkdirSync(path.join(home, 'flutters', 'flutter-3.49.0'), { recursive: true });
    fs.mkdirSync(path.join(home, 'flutters', 'flutter-3.49.0-0.1.pre'), { recursive: true });
    expect(findInstalled('maven', 'latest').dirPath.endsWith('maven-4.0.0')).toBe(true);
    expect(findInstalled('maven', '4').dirPath.endsWith('maven-4.0.0')).toBe(true);
    expect(findInstalled('maven', '4.0').dirPath.endsWith('maven-4.0.0')).toBe(true);
    expect(findInstalled('maven', '4.0.0-rc-4').dirPath.endsWith('maven-4.0.0-rc-4')).toBe(true);
    expect(findInstalled('flutter', 'latest').dirPath.endsWith('flutter-3.49.0')).toBe(true);
    expect(findInstalled('flutter', '3.49').dirPath.endsWith('flutter-3.49.0')).toBe(true);
    expect(findInstalled('flutter', '3.49.0-0.1.pre').dirPath.endsWith('flutter-3.49.0-0.1.pre')).toBe(true);
  });

  it('install hint uses the full version for a prerelease', () => {
    expect(installUseHint('python', parsePythonVersion('cpython', '3.14.0rc2'))).toBe('3.14.0rc2');
    expect(installUseHint('python', parsePythonVersion('cpython', '3.12.7'))).toBe('3.12');
    expect(installUseHint('maven', parseMavenVersion('maven', '4.0.0-rc-4'))).toBe('4.0.0-rc-4');
    expect(installUseHint('maven', parseMavenVersion('maven', '3.9.9'))).toBe('3.9');
    expect(installUseHint('flutter', parseFlutterVersion('flutter', '3.49.0-0.1.pre'))).toBe('3.49.0-0.1.pre');
    expect(installUseHint('java', parseVersion('temurin', '21.0.5+11'))).toBe('21');
    expect(installUseHint('node', parseNodeVersion('nodejs', '22.20.0'))).toBe('22');
  });

  it('python line and latest prefer the final release over a prerelease of the same numbers', () => {
    const root = path.join(home, 'pythons');
    fs.mkdirSync(path.join(root, 'cpython-3.12.7'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cpython-3.14.0rc2'), { recursive: true });
    fs.mkdirSync(path.join(root, 'cpython-3.14.0'), { recursive: true });
    expect(findInstalled('python', 'latest').dirPath.endsWith('cpython-3.14.0')).toBe(true);
    expect(findInstalled('python', '3.14').dirPath.endsWith('cpython-3.14.0')).toBe(true);
    expect(findInstalled('python', '3.14.0').dirPath.endsWith('cpython-3.14.0')).toBe(true);
    expect(findInstalled('python', '3.14.0rc2').dirPath.endsWith('cpython-3.14.0rc2')).toBe(true);
  });

  it('no match throws with installed list', () => {
    mkJdk('temurin-21.0.5+11');
    try {
      findInstalled('java', '99');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SdkvmError);
      expect((e as SdkvmError).hint).toContain('temurin-21.0.5+11');
    }
  });
});

describe('refinedUseHint', () => {
  it('刚装的就是该 major 最新时保持 major 提示', () => {
    mkJdk('temurin-21.0.5+11');
    expect(refinedUseHint('java', parseVersion('temurin', '21.0.5+11'), '21')).toBe('21');
  });

  it('该 major 已有更新的已装版本时退回带 vendor 的完整规格', () => {
    mkJdk('temurin-21.0.6+7');
    expect(refinedUseHint('java', parseVersion('temurin', '21.0.5+11'), '21')).toBe('temurin-21.0.5+11');
  });

  it('跨 vendor 的更新已装版本同样让提示退回完整规格', () => {
    mkJdk('zulu-21.0.12.1');
    expect(refinedUseHint('java', parseVersion('temurin', '21.0.5+11'), '21')).toBe('temurin-21.0.5+11');
  });

  it('其它 major 不影响提示', () => {
    mkJdk('temurin-17.0.13+11');
    expect(refinedUseHint('java', parseVersion('temurin', '21.0.5+11'), '21')).toBe('21');
  });

  it('wanted 带 build 而已装目录不带（zulu）时反向命中', () => {
    mkJdk('zulu-21.0.5');
    expect(findInstalled('java', 'zulu-21.0.5+11').dirPath.endsWith('zulu-21.0.5')).toBe(true);
  });

  it('非 java/node 类型原样返回', () => {
    expect(refinedUseHint('maven', parseMavenVersion('maven', '3.9.9'), '3.9')).toBe('3.9');
  });
});
