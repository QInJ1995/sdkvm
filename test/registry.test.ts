import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installUseHint, refinedUseHint } from '../src/cli/install.js';
import { currentSdk, findInstalled, listInstalled } from '../src/core/registry.js';
import { clearCurrent, readCurrent, setCurrent } from '../src/fs/link.js';
import { detectPlatform } from '../src/core/platform.js';
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

  it('settled incomplete marker still lists the install; an in-progress marker hides it', () => {
    const settled = path.join(home, 'jdks', 'temurin-21.0.5+11');
    mkJdk('temurin-21.0.5+11');
    fs.writeFileSync(
      `${settled}.incomplete`,
      JSON.stringify({ startedAt: 1, replacing: false, mode: 'archive', settled: true }),
    );
    expect(listInstalled('java').map((j) => j.version.major)).toEqual([21]);

    const pending = path.join(home, 'jdks', 'temurin-17.0.13+11');
    mkJdk('temurin-17.0.13+11');
    fs.writeFileSync(`${pending}.incomplete`, JSON.stringify({ startedAt: 1, replacing: false, mode: 'archive' }));
    expect(listInstalled('java').map((j) => j.version.major)).toEqual([21]);
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

  it('X.0 / X.0.0 折叠显示的目录仍可被完整输入命中', () => {
    // formatVersion 把 21.0 / 21.0.0 折叠成 "21"：输入 "21.0" 不能因此失配
    mkJdk('temurin-21');
    expect(findInstalled('java', '21.0').dirPath.endsWith('temurin-21')).toBe(true);
    expect(findInstalled('java', '21.0.0').dirPath.endsWith('temurin-21')).toBe(true);
    // 折叠不影响真正的 21.x：21.5 不命中 21
    expect(() => findInstalled('java', '21.5')).toThrow(/matches "21\.5"/);
  });

  it('--vendor 大小写不敏感', () => {
    mkJdk('corretto-21.0.5.6.1');
    mkJdk('temurin-21.0.5+11');
    // 输入前缀（parseUserSpec）会 toLowerCase；--vendor 参数此前没有，会静默过滤成空集
    expect(findInstalled('java', '21', 'Corretto').dirPath.endsWith('corretto-21.0.5.6.1')).toBe(true);
  });

  it('同版本跨 vendor 并存时优先 defaultVendor', () => {
    mkJdk('temurin-21.0.5+11');
    mkJdk('zulu-21.0.5+11');
    // 默认 temurin：不再由 localeCompare 字母序决定
    expect(findInstalled('java', '21.0.5').dirPath.endsWith('temurin-21.0.5+11')).toBe(true);
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ version: 1, defaultVendor: 'zulu', mirror: {}, npmRegistries: {}, mavenRegistries: {}, mavenSettings: '' }),
    );
    expect(findInstalled('java', '21.0.5').dirPath.endsWith('zulu-21.0.5+11')).toBe(true);
  });

  it('输入带 build 时不再被 norm 折叠误配到其它 build', () => {
    mkJdk('temurin-21.0.5+9');
    // 21.0.5（不带 build）仍应命中；21.0.5+11 是另一个构建，不能命中 +9
    expect(findInstalled('java', '21.0.5').dirPath.endsWith('temurin-21.0.5+9')).toBe(true);
    expect(() => findInstalled('java', '21.0.5+11')).toThrow(/matches "21\.0\.5\+11"/);
  });

  it('lts match', () => {
    mkJdk('temurin-21.0.5+11');
    mkJdk('temurin-22.0.1+2');
    expect(findInstalled('java', 'lts').version.major).toBe(21);
  });

  it('lts 未命中且已装比静态表更新的 major 时，提示表可能过时（JDK 29 场景）', () => {
    // LTS_MAJORS 静态表更新滞后：install lts（Adoptium API 动态）装上 29 后，
    // use lts（静态表）匹配不到——hint 必须点破，而不是让用户循环重装
    mkJdk('temurin-29.0.1+1');
    let caught: unknown = null;
    try {
      findInstalled('java', 'lts');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SdkvmError);
    expect(String((caught as SdkvmError).hint)).toMatch(/LTS table may lag/);
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

// 链接目标与 readdir 拼写不一致（macOS 的 /tmp → /private/tmp、/var → /private/var）
// 时，currentSdk 仍必须命中已装目录：否则 uninstall 会误判"非当前版本"而漏清 rc
describe.skipIf(process.platform === 'win32')('currentSdk 路径拼写归一', () => {
  it('链接目标用 realpath 拼写、安装目录用符号链接拼写时仍匹配', () => {
    const dirName = 'temurin-21.0.5+11';
    const javaHome = path.join(home, 'jdks', dirName, 'Contents', 'Home');
    fs.mkdirSync(javaHome, { recursive: true });
    // 模拟两次会话用不同拼写：use 时 SDKVM_HOME 是 realpath 形态，
    // 后续 readdir 拼出的目录是 mkdtemp 的原始形态
    const realHome = fs.realpathSync(home);
    expect(realHome === home || realHome.endsWith(path.basename(home))).toBe(true);
    setCurrent('java', path.join(realHome, 'jdks', dirName, 'Contents', 'Home'), detectPlatform());

    const current = currentSdk('java');
    // 命中即关键：uninstall 据此判定"当前版本"并清理 rc/链接
    expect(current?.dirPath).toBe(path.join(home, 'jdks', dirName));
  });

  it('悬空链接（目标已删）不当成匹配，返回 null', () => {
    fs.mkdirSync(path.join(home, 'jdks', 'temurin-21.0.5+11'), { recursive: true });
    fs.symlinkSync('/nonexistent/sdkvm/jdk', path.join(home, 'current-java'));
    expect(currentSdk('java')).toBeNull();
  });
});

describe('current 链接删除', () => {
  it('clearCurrent 只摘掉链接，不删除目标目录', () => {
    const target = path.join(home, 'jdks', 'temurin-21');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'marker'), 'keep');
    setCurrent('java', target, detectPlatform());
    clearCurrent('java');
    expect(fs.existsSync(path.join(target, 'marker'))).toBe(true);
    expect(fs.existsSync(path.join(home, 'current-java'))).toBe(false);
  });
});

describe('readCurrent junction', () => {
  it('lstat 把链接报成目录时仍能读出目标', () => {
    const target = path.join(home, 'jdks', 'temurin-21');
    fs.mkdirSync(target, { recursive: true });
    const link = path.join(home, 'current-java');
    const realLstat = fs.lstatSync.bind(fs);
    const realReadlink = fs.readlinkSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === link) {
        return { isSymbolicLink: () => false, isDirectory: () => true } as fs.Stats;
      }
      return realLstat(p);
    }) as typeof fs.lstatSync);
    vi.spyOn(fs, 'readlinkSync').mockImplementation(((p: fs.PathLike) => {
      if (String(p) === link) return target;
      return realReadlink(p);
    }) as typeof fs.readlinkSync);
    try {
      expect(readCurrent('java')).toBe(path.resolve(target));
    } finally {
      vi.restoreAllMocks();
    }
  });
});

  it('corretto 8 补零目录可被未补零输入命中（数值段归一）', () => {
    // 安装侧 canonical 化 8.504.01.1（patch 补零）；用户按原样 8.504.1.1 重输也应命中
    mkJdk('corretto-8.504.01.1');
    expect(findInstalled('java', 'corretto-8.504.1.1').dirPath.endsWith('corretto-8.504.01.1')).toBe(true);
    // 数值不同仍不能命中
    expect(() => findInstalled('java', 'corretto-8.504.2.1')).toThrow(/matches/);
  });
