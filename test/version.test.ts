import { describe, expect, it } from 'vitest';
import {
  compareTaggedVersions,
  compareVersions,
  formatFlutterVersion,
  formatGoVersion,
  parseFlutterDirName,
  parseFlutterUserSpec,
  parseFlutterVersion,
  formatVersion,
  parseDirName,
  toDirName,
  parseGoDirName,
  parseGoUserSpec,
  parseGoVersion,
  parseUserSpec,
  parseVersion,
  parseNodeVersion,
  formatNodeVersion,
  parseNodeDirName,
  parseNodeUserSpec,
  parseMavenVersion,
  formatMavenVersion,
  parseMavenDirName,
  parseMavenUserSpec,
  parseMinicondaVersion,
  formatMinicondaVersion,
  parseMinicondaDirName,
  parseMinicondaUserSpec,
  parsePythonVersion,
  formatPythonVersion,
  parsePythonDirName,
  parsePythonUserSpec,
  comparePythonVersions,
} from '../src/core/version.js';
import { SdkvmError } from '../src/util/errors.js';

describe('parseVersion', () => {
  it('parses temurin with build', () => {
    const v = parseVersion('temurin', '21.0.5+11');
    expect([v.major, v.minor, v.patch]).toEqual([21, 0, 5]);
    expect(v.extra).toBeNull();
    expect(v.build).toBe('11');
  });

  it('parses temurin 4-segment with build', () => {
    const v = parseVersion('temurin', '21.0.12.1+1');
    expect(v.extra).toBe('1');
    expect(v.build).toBe('1');
    expect(formatVersion(v)).toBe('21.0.12.1+1');
  });

  it('parses corretto 5-segment', () => {
    const v = parseVersion('corretto', '21.0.12.9.1');
    expect(v.extra).toBe('9.1');
    expect(v.build).toBeNull();
    expect(formatVersion(v)).toBe('21.0.12.9.1');
  });

  it('parses zulu 4-segment', () => {
    const v = parseVersion('zulu', '21.0.12.1');
    expect(v.extra).toBe('1');
    expect(formatVersion(v)).toBe('21.0.12.1');
  });

  it('strips jdk- prefix', () => {
    expect(parseVersion('temurin', 'jdk-21.0.5+11').build).toBe('11');
  });

  it('major only formats back to major', () => {
    expect(formatVersion(parseVersion('temurin', '21'))).toBe('21');
    expect(formatVersion(parseVersion('temurin', 'jdk-21'))).toBe('21');
    expect(formatVersion(parseVersion('temurin', 'temurin-21'))).toBe('21');
  });

  it('X.0.0 only folds when the input itself was the bare major', () => {
    // 用户输入裸 major → 目录折叠回 "21"
    expect(toDirName(parseVersion('temurin', '21'))).toBe('temurin-21');
    // API 派生的三段 [21,0,0]（Zulu GA 的 java_version 数组）保持 21.0.0，
    // 不能塌成 zulu-21 与按 major 安装的目录混淆
    expect(formatVersion(parseVersion('zulu', '21.0.0'))).toBe('21.0.0');
    expect(toDirName(parseVersion('zulu', '21.0.0'))).toBe('zulu-21.0.0');
    // 目录名 temurin-21 回读后再写出保持稳定（不变成 21.0.0）
    expect(formatVersion(parseVersion('temurin', '21'))).toBe('21');
  });

  it('keeps leading zeros that Number() would drop', () => {
    expect(formatVersion(parseVersion('corretto', '8.504.01.1'))).toBe('8.504.01.1');
    expect(formatVersion(parseVersion('corretto', '8.504.1.1'))).toBe('8.504.1.1');
  });

  it('rejects garbage', () => {
    expect(() => parseVersion('temurin', 'abc')).toThrow(SdkvmError);
    expect(() => parseVersion('temurin', '21.x.5')).toThrow(SdkvmError);
  });

  it('rejects hex / scientific / negative segments Number() would accept', () => {
    expect(() => parseVersion('temurin', '21.0x10')).toThrow(SdkvmError);
    expect(() => parseVersion('temurin', '21.1e2')).toThrow(SdkvmError);
    expect(() => parseVersion('temurin', '21.-1')).toThrow(SdkvmError);
  });
});

describe('compareVersions', () => {
  const t = (s: string) => parseVersion('temurin', s);
  it('builds compare numerically', () => {
    expect(compareVersions(t('21.0.5+9'), t('21.0.5+11'))).toBeLessThan(0);
  });
  it('numeric not lexicographic segments', () => {
    expect(compareVersions(t('21.0.4.9.1'), t('21.0.4.10.1'))).toBeLessThan(0);
  });
  it('missing extra is smaller', () => {
    expect(compareVersions(t('21.0.12'), t('21.0.12.1'))).toBeLessThan(0);
  });
  it('major dominates', () => {
    expect(compareVersions(t('21.9.9'), t('22.0.0'))).toBeLessThan(0);
  });
});

describe('parseDirName', () => {
  it('roundtrip', () => {
    const v = parseDirName('temurin-21.0.5+11');
    expect(v?.vendor).toBe('temurin');
    expect(v?.build).toBe('11');
  });
  it('rejects unknown', () => {
    expect(parseDirName('foo')).toBeNull();
    expect(parseDirName('graal-21')).toBeNull();
  });
});

describe('parseUserSpec', () => {
  it('major / lts / full', () => {
    expect(parseUserSpec('21').spec).toEqual({ kind: 'major', major: 21 });
    expect(parseUserSpec('lts').spec).toEqual({ kind: 'lts' });
    expect(parseUserSpec('21.0.5+11').spec).toEqual({ kind: 'full', version: '21.0.5+11' });
  });
  it('vendor prefix', () => {
    const r = parseUserSpec('zulu-21');
    expect(r.vendor).toBe('zulu');
    expect(r.spec).toEqual({ kind: 'major', major: 21 });
  });
  it('invalid throws', () => {
    expect(() => parseUserSpec('hello')).toThrow(SdkvmError);
  });
});

describe('parseGoVersion', () => {
  it('parses 1.24.5', () => {
    const v = parseGoVersion('golang', '1.24.5');
    expect([v.major, v.minor, v.patch]).toEqual([1, 24, 5]);
    expect(v.extra).toBeNull();
    expect(v.build).toBeNull();
  });

  it('tolerates go/golang- prefixes', () => {
    expect(parseGoVersion('golang', 'go1.24.5').patch).toBe(5);
    expect(parseGoVersion('golang', 'golang-1.24.5').minor).toBe(24);
  });

  it('base release has null patch and formats without segment', () => {
    const v = parseGoVersion('golang', 'go1.24');
    expect(v.patch).toBeNull();
    expect(formatGoVersion(v)).toBe('1.24');
  });

  it('rejects garbage and 4-segment', () => {
    expect(() => parseGoVersion('golang', 'abc')).toThrow(SdkvmError);
    expect(() => parseGoVersion('golang', '1.24.5.6')).toThrow(SdkvmError);
  });

  it('compare treats null patch as 0', () => {
    const base = parseGoVersion('golang', '1.24');
    const patch = parseGoVersion('golang', '1.24.1');
    expect(compareVersions(base, patch)).toBeLessThan(0);
  });
});

describe('parseGoUserSpec', () => {
  it('line / full / latest', () => {
    expect(parseGoUserSpec('1.24').spec).toEqual({ kind: 'line', major: 1, minor: 24 });
    expect(parseGoUserSpec('1.24.5').spec).toEqual({ kind: 'full', version: '1.24.5' });
    expect(parseGoUserSpec('latest').spec).toEqual({ kind: 'latest' });
  });
  it('golang- prefix', () => {
    const r = parseGoUserSpec('golang-1.24');
    expect(r.vendor).toBe('golang');
    expect(r.spec).toEqual({ kind: 'line', major: 1, minor: 24 });
  });
  it('rejects bare 1 / bare 24 / garbage', () => {
    expect(() => parseGoUserSpec('1')).toThrow(SdkvmError);
    expect(() => parseGoUserSpec('24')).toThrow(SdkvmError);
    expect(() => parseGoUserSpec('lts')).toThrow(SdkvmError);
  });
});

describe('parseGoDirName', () => {
  it('roundtrip', () => {
    const v = parseGoDirName('golang-1.24.5');
    expect(v?.vendor).toBe('golang');
    expect(v?.patch).toBe(5);
    expect(parseGoDirName('golang-1.24')?.patch).toBeNull();
  });
  it('rejects java dirs', () => {
    expect(parseGoDirName('temurin-21')).toBeNull();
    expect(parseGoDirName('random')).toBeNull();
  });
});


describe('flutter version parsing', () => {
  it('parses stable version', () => {
    const v = parseFlutterVersion('flutter', '3.47.5');
    expect([v.major, v.minor, v.patch]).toEqual([3, 47, 5]);
    expect(v.extra).toBeNull();
    expect(formatFlutterVersion(v)).toBe('3.47.5');
  });

  it('parses prerelease into extra', () => {
    const v = parseFlutterVersion('flutter', '3.49.0-0.1.pre');
    expect(v.extra).toBe('0.1.pre');
    expect(formatFlutterVersion(v)).toBe('3.49.0-0.1.pre');
  });

  it('parses legacy v-prefixed versions', () => {
    const v = parseFlutterVersion('flutter', 'v0.1.6');
    expect([v.major, v.minor, v.patch]).toEqual([0, 1, 6]);
    expect(formatFlutterVersion(v)).toBe('0.1.6');
  });

  it('strips flutter- prefix', () => {
    const v = parseFlutterVersion('flutter', 'flutter-3.47.5');
    expect(v.major).toBe(3);
  });

  it('user spec: line / full / prerelease / latest / vendor prefix', () => {
    expect(parseFlutterUserSpec('3.47')).toEqual({ spec: { kind: 'line', major: 3, minor: 47 } });
    expect(parseFlutterUserSpec('3.47.5')).toEqual({ spec: { kind: 'full', version: '3.47.5' } });
    expect(parseFlutterUserSpec('3.49.0-0.1.pre')).toEqual({ spec: { kind: 'full', version: '3.49.0-0.1.pre' } });
    expect(parseFlutterUserSpec('latest')).toEqual({ spec: { kind: 'latest' } });
    expect(parseFlutterUserSpec('flutter-3.47')).toEqual({
      vendor: 'flutter',
      spec: { kind: 'line', major: 3, minor: 47 },
    });
  });

  it('user spec: bare major rejected with hint', () => {
    expect(() => parseFlutterUserSpec('3')).toThrow(SdkvmError);
    let hint: string | undefined;
    try {
      parseFlutterUserSpec('3');
    } catch (err) {
      hint = (err as SdkvmError).hint;
    }
    expect(hint).toMatch(/Bare major is ambiguous/);
  });

  it('dir name parse round-trip', () => {
    const v = parseFlutterDirName('flutter-3.49.0-0.1.pre');
    expect(v?.vendor).toBe('flutter');
    expect(formatFlutterVersion(v as never)).toBe('3.49.0-0.1.pre');
    expect(parseFlutterDirName('golang-1.24.5')).toBeNull();
    expect(parseFlutterDirName('flutter-abc')).toBeNull();
  });
});


describe('node version parsing', () => {
  it('parses v/node-/nodejs- prefixed versions', () => {
    expect(parseNodeVersion('nodejs', 'v22.20.0')).toMatchObject({ major: 22, minor: 20, patch: 0 });
    expect(parseNodeVersion('nodejs', 'node-22.20.0')).toMatchObject({ major: 22, minor: 20, patch: 0 });
    expect(parseNodeVersion('nodejs', 'nodejs-22.20.0')).toMatchObject({ major: 22, minor: 20, patch: 0 });
    expect(formatNodeVersion(parseNodeVersion('nodejs', 'v22.20.0'))).toBe('22.20.0');
  });

  it('user spec: major / lts / latest / full / vendor prefix', () => {
    expect(parseNodeUserSpec('22')).toEqual({ spec: { kind: 'major', major: 22 } });
    expect(parseNodeUserSpec('lts')).toEqual({ spec: { kind: 'lts' } });
    expect(parseNodeUserSpec('latest')).toEqual({ spec: { kind: 'latest' } });
    expect(parseNodeUserSpec('22.20.0')).toEqual({ spec: { kind: 'full', version: '22.20.0' } });
    expect(parseNodeUserSpec('node-22.20.0')).toEqual({ vendor: 'nodejs', spec: { kind: 'full', version: '22.20.0' } });
  });

  it('user spec: two-part version rejected with hint', () => {
    let hint: string | undefined;
    try {
      parseNodeUserSpec('22.20');
    } catch (err) {
      hint = (err as SdkvmError).hint;
    }
    expect(hint).toMatch(/major-only/);
  });

  it('dir name parse round-trip', () => {
    const v = parseNodeDirName('nodejs-22.20.0');
    expect(v?.vendor).toBe('nodejs');
    expect(formatNodeVersion(v as never)).toBe('22.20.0');
    expect(parseNodeDirName('node-22.20.0')).toBeNull();
    expect(parseNodeDirName('golang-1.24.5')).toBeNull();
  });
});

describe('maven version parsing', () => {
  it('parses maven-/v prefixes and prerelease extra', () => {
    expect(parseMavenVersion('maven', 'maven-3.9.9')).toMatchObject({ major: 3, minor: 9, patch: 9, extra: null });
    const pre = parseMavenVersion('maven', 'v4.0.0-rc-4');
    expect(pre.extra).toBe('rc-4');
    expect(formatMavenVersion(pre)).toBe('4.0.0-rc-4');
    expect(formatMavenVersion(parseMavenVersion('maven', '3.9.9'))).toBe('3.9.9');
  });

  it('user spec: major / line / full / prerelease / latest / vendor prefix', () => {
    expect(parseMavenUserSpec('3')).toEqual({ spec: { kind: 'major', major: 3 } });
    expect(parseMavenUserSpec('3.9')).toEqual({ spec: { kind: 'line', major: 3, minor: 9 } });
    expect(parseMavenUserSpec('3.9.9')).toEqual({ spec: { kind: 'full', version: '3.9.9' } });
    expect(parseMavenUserSpec('4.0.0-rc-4')).toEqual({ spec: { kind: 'full', version: '4.0.0-rc-4' } });
    expect(parseMavenUserSpec('3.9.9-rc-1')).toEqual({ spec: { kind: 'full', version: '3.9.9-rc-1' } });
    expect(parseMavenUserSpec('latest')).toEqual({ spec: { kind: 'latest' } });
    expect(parseMavenUserSpec('maven-3.9.9')).toEqual({
      vendor: 'maven',
      spec: { kind: 'full', version: '3.9.9' },
    });
  });

  it('user spec: lts is rejected', () => {
    let hint: string | undefined;
    try {
      parseMavenUserSpec('lts');
    } catch (err) {
      hint = (err as SdkvmError).hint;
    }
    expect(hint).toMatch(/no lts/);
  });

  it('dir name parse round-trip', () => {
    const v = parseMavenDirName('maven-4.0.0-rc-4');
    expect(v?.vendor).toBe('maven');
    expect(formatMavenVersion(v as never)).toBe('4.0.0-rc-4');
    expect(parseMavenDirName('nodejs-22.20.0')).toBeNull();
    expect(parseMavenDirName('maven-3')).toBeNull();
  });

  it('ranks a release ahead of its prerelease, and rc-10 ahead of rc-4', () => {
    const v = (s: string) => parseMavenVersion('maven', s);
    expect(compareTaggedVersions(v('4.0.0'), v('4.0.0-rc-4'))).toBeGreaterThan(0);
    expect(compareTaggedVersions(v('4.0.0-rc-10'), v('4.0.0-rc-4'))).toBeGreaterThan(0);
    expect(compareTaggedVersions(v('4.0.0-rc-1'), v('4.0.0-beta-2'))).toBeGreaterThan(0);
    expect(compareTaggedVersions(v('4.0.0-beta-1'), v('4.0.0-alpha-2'))).toBeGreaterThan(0);
    const flutter = (s: string) => parseFlutterVersion('flutter', s);
    expect(compareTaggedVersions(flutter('3.49.0'), flutter('3.49.0-0.1.pre'))).toBeGreaterThan(0);
    expect(compareTaggedVersions(flutter('3.49.0-0.10.pre'), flutter('3.49.0-0.2.pre'))).toBeGreaterThan(0);
  });
});

describe('miniconda version parsing', () => {
  it('parses python tag, semver, and build', () => {
    expect(parseMinicondaVersion('miniconda', 'py313_26.7.1-1')).toMatchObject({
      major: 26,
      minor: 7,
      patch: 1,
      extra: '3.13',
      build: '1',
    });
    expect(formatMinicondaVersion(parseMinicondaVersion('miniconda', 'py39_4.12.0'))).toBe('py39_4.12.0');
    expect(formatMinicondaVersion(parseMinicondaVersion('miniconda', 'miniconda-py310_23.11.0-2'))).toBe(
      'py310_23.11.0-2',
    );
    expect(compareVersions(
      parseMinicondaVersion('miniconda', 'py313_26.7.1-1'),
      parseMinicondaVersion('miniconda', 'py314_26.7.1-1'),
    )).toBe(-1);
  });

  it('user spec: major / line / build / python / latest / vendor prefix', () => {
    expect(parseMinicondaUserSpec('26')).toEqual({ spec: { kind: 'major', major: 26 } });
    expect(parseMinicondaUserSpec('26.7')).toEqual({ spec: { kind: 'line', major: 26, minor: 7 } });
    expect(parseMinicondaUserSpec('26.7.1-1')).toEqual({ spec: { kind: 'full', version: '26.7.1-1' } });
    expect(parseMinicondaUserSpec('py313')).toEqual({ spec: { kind: 'full', version: 'py313' } });
    expect(parseMinicondaUserSpec('py313_26.7.1-1')).toEqual({ spec: { kind: 'full', version: 'py313_26.7.1-1' } });
    expect(parseMinicondaUserSpec('latest')).toEqual({ spec: { kind: 'latest' } });
    expect(parseMinicondaUserSpec('miniconda-py313_26.7.1-1')).toEqual({
      vendor: 'miniconda',
      spec: { kind: 'full', version: 'py313_26.7.1-1' },
    });
  });

  it('user spec: lts and anaconda-style calendar versions are rejected', () => {
    let hint: string | undefined;
    try {
      parseMinicondaUserSpec('lts');
    } catch (err) {
      hint = (err as SdkvmError).hint;
    }
    expect(hint).toMatch(/no lts/);
    expect(() => parseMinicondaUserSpec('2025.12-2')).toThrow(/Invalid Miniconda version/);
    expect(() => parseMinicondaUserSpec('py3')).toThrow(/Invalid Miniconda version/);
  });

  it('dir name parse round-trip', () => {
    const v = parseMinicondaDirName('miniconda-py313_26.7.1-1');
    expect(v?.vendor).toBe('miniconda');
    expect(formatMinicondaVersion(v as never)).toBe('py313_26.7.1-1');
    expect(parseMinicondaDirName('maven-3.9.9')).toBeNull();
    expect(parseMinicondaDirName('miniconda-26.7')).toBeNull();
  });
});

describe('python version parsing', () => {
  it('parses stable and prerelease, and drops the build date', () => {
    expect(parsePythonVersion('cpython', '3.12.7')).toMatchObject({
      major: 3,
      minor: 12,
      patch: 7,
      extra: null,
      build: null,
    });
    expect(parsePythonVersion('cpython', '3.14.0rc2')).toMatchObject({ extra: 'rc2', build: null });
    expect(parsePythonVersion('cpython', '3.15.0a1').extra).toBe('a1');
    expect(parsePythonVersion('cpython', 'cpython-3.13.1b2').extra).toBe('b2');
    expect(formatPythonVersion(parsePythonVersion('cpython', '3.14.0rc2'))).toBe('3.14.0rc2');
    expect(formatPythonVersion(parsePythonVersion('cpython', '3.12.7'))).toBe('3.12.7');
  });

  it('user spec: major / line / full / prerelease / latest / vendor prefix', () => {
    expect(parsePythonUserSpec('3')).toEqual({ spec: { kind: 'major', major: 3 } });
    expect(parsePythonUserSpec('3.12')).toEqual({ spec: { kind: 'line', major: 3, minor: 12 } });
    expect(parsePythonUserSpec('3.12.7')).toEqual({ spec: { kind: 'full', version: '3.12.7' } });
    expect(parsePythonUserSpec('3.14.0rc2')).toEqual({ spec: { kind: 'full', version: '3.14.0rc2' } });
    expect(parsePythonUserSpec('latest')).toEqual({ spec: { kind: 'latest' } });
    expect(parsePythonUserSpec('cpython-3.12.7')).toEqual({
      vendor: 'cpython',
      spec: { kind: 'full', version: '3.12.7' },
    });
  });

  it('rejects lts and incomplete forms', () => {
    let hint: string | undefined;
    try {
      parsePythonUserSpec('lts');
    } catch (err) {
      hint = (err as SdkvmError).hint;
    }
    expect(hint).toMatch(/no lts/);
    expect(() => parsePythonUserSpec('3.12.7-rc2')).toThrow(/Invalid Python version/);
    expect(() => parsePythonUserSpec('latest-3.12')).toThrow(/Invalid Python version/);
  });

  it('dir name parse round-trip', () => {
    const stable = parsePythonDirName('cpython-3.12.7');
    expect(stable?.vendor).toBe('cpython');
    expect(formatPythonVersion(stable as never)).toBe('3.12.7');
    const pre = parsePythonDirName('cpython-3.14.0rc2');
    expect(formatPythonVersion(pre as never)).toBe('3.14.0rc2');
    expect(parsePythonDirName('python-3.12.7')).toBeNull();
    expect(parsePythonDirName('cpython-3.12')).toBeNull();
  });

  it('ranks a release ahead of its prerelease, and rc10 ahead of rc2', () => {
    const v = (s: string) => parsePythonVersion('cpython', s);
    expect(comparePythonVersions(v('3.14.0'), v('3.14.0rc2'))).toBeGreaterThan(0);
    expect(comparePythonVersions(v('3.14.0rc10'), v('3.14.0rc2'))).toBeGreaterThan(0);
    expect(comparePythonVersions(v('3.14.0rc2'), v('3.14.0b1'))).toBeGreaterThan(0);
    expect(comparePythonVersions(v('3.14.0b1'), v('3.14.0a2'))).toBeGreaterThan(0);
    expect(comparePythonVersions(v('3.15.0a1'), v('3.14.0'))).toBeGreaterThan(0);
  });
});

describe('java 旧式 1.x 语法', () => {
  it('1.8 等价于 major 8', () => {
    expect(parseUserSpec('1.8')).toEqual({ spec: { kind: 'major', major: 8 } });
    expect(parseUserSpec('zulu-1.8')).toEqual({ vendor: 'zulu', spec: { kind: 'major', major: 8 } });
  });

  it('1.8.0_392 这类更新号写法被拒绝并给出改写提示', () => {
    expect(() => parseUserSpec('1.8.0_392')).toThrow(/Invalid version: "1\.8\.0_392"/);
  });
});

describe('JDK 8 跨厂商排序', () => {
  // Corretto 把 update 放 minor（8.504.01.1），Temurin/Zulu 放 patch（8.0.504+1）：
  // minor 先于 patch 比较会让任何 Corretto 8 压过更高 update 的 Temurin/Zulu 8
  it('按统一后的 update 分胜负，不按 minor 编码差异', () => {
    const c504 = parseVersion('corretto', '8.504.01.1');
    const t504 = parseVersion('temurin', '8.0.504+1');
    const t512 = parseVersion('temurin', '8.0.512+6');
    const z504 = parseVersion('zulu', '8.0.504');
    expect(compareVersions(t512, c504)).toBe(1);
    expect(compareVersions(c504, t512)).toBe(-1);
    expect(compareVersions(c504, t504)).toBe(0);
    expect(compareVersions(c504, z504)).toBe(1); // build 决胜：extra 1 vs 无 build
  });

  it('同 update 平手时 Corretto 的 extra 段参与 build 决胜', () => {
    const c1 = parseVersion('corretto', '8.504.01.1');
    const t2 = parseVersion('temurin', '8.0.504+2');
    expect(compareVersions(c1, t2)).toBe(-1);
    expect(compareVersions(t2, c1)).toBe(1);
  });
});

describe('用户输入 v / go 前缀', () => {
  it('java：v21 / V21.0.5+11 与无前缀等价', () => {
    expect(parseUserSpec('v21')).toEqual(parseUserSpec('21'));
    expect(parseUserSpec('V21.0.5+11')).toEqual(parseUserSpec('21.0.5+11'));
    expect(parseUserSpec('zulu-v8.0.504')).toEqual(parseUserSpec('zulu-8.0.504'));
  });

  it('go：go1.24.3 / v1.24 与无前缀等价；裸 "go" 仍被拒绝', () => {
    expect(parseGoUserSpec('go1.24.3')).toEqual(parseGoUserSpec('1.24.3'));
    expect(parseGoUserSpec('v1.24')).toEqual(parseGoUserSpec('1.24'));
    expect(() => parseGoUserSpec('go')).toThrow();
  });

  it('node：v22.11.0 与无前缀等价', () => {
    expect(parseNodeUserSpec('v22.11.0')).toEqual(parseNodeUserSpec('22.11.0'));
    expect(parseNodeUserSpec('v22')).toEqual(parseNodeUserSpec('22'));
  });
});
