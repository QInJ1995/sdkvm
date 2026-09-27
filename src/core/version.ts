import { SdkvmError } from '../util/errors.js';

/** 厂商 id：全局唯一字符串（temurin/zulu/corretto/golang），config.mirror 以它为键 */
export type VendorId = string;

/** 与 Adoptium available_lts_releases 对齐的 LTS major 集（仅 java） */
export const LTS_MAJORS = new Set([8, 11, 17, 21, 25]);

export const JAVA_VENDOR_IDS = ['temurin', 'zulu', 'corretto'] as const;

/** 统一版本模型：java（extra/build 段）与 go（patch 可空）共用 */
export interface SdkVersion {
  vendor: VendorId;
  major: number;
  minor: number;
  /** go 基础版（go1.24）无 patch 段 */
  patch: number | null;
  /** major.minor.patch 之后的额外段（temurin "21.0.12.1+1" 的 "1"、corretto "21.0.12.9.1" 的 "9.1"） */
  extra: string | null;
  /** "+" 之后的 build 号（temurin/zulu "11"） */
  build: string | null;
  raw: string;
}

/** 解析 java 版本串。容忍 vendor 前缀（"jdk-21.0.5+11" / "temurin-21"）。 */
export function parseVersion(vendor: VendorId, input: string): SdkVersion {
  const raw = input.trim();
  const vendorPrefix = new RegExp(`^(${JAVA_VENDOR_IDS.join('|')})-`, 'i');
  let s = raw.replace(/^jdk-/i, '').replace(vendorPrefix, '').replace(/^v/i, '');
  s = s.replace(/^zulu\d[\d.]*-ca-jdk[\d.]*-?/i, ''); // zulu 文件名里混入的发行版号

  const plusIdx = s.indexOf('+');
  const basePart = plusIdx >= 0 ? s.slice(0, plusIdx) : s;
  const build = plusIdx >= 0 ? s.slice(plusIdx + 1) : null;

  const segs = basePart.split('.').filter((x) => x.length > 0);
  if (segs.length === 0) {
    throw new SdkvmError(`Invalid JDK version: "${input}"`);
  }
  const nums = segs.map((x) => Number(x));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new SdkvmError(`Invalid JDK version: "${input}"`, {
      hint: 'Expected forms: 21, 21.0.5, 21.0.5+11',
    });
  }
  return {
    vendor,
    major: nums[0] as number,
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
    extra: segs.length > 3 ? segs.slice(3).join('.') : null,
    build,
    raw,
  };
}

export function formatVersion(v: SdkVersion): string {
  if (v.patch !== null && v.minor === 0 && v.patch === 0 && !v.extra && !v.build) return String(v.major);
  let s = `${v.major}.${v.minor}.${v.patch ?? 0}`;
  if (v.extra) s += `.${v.extra}`;
  if (v.build) s += `+${v.build}`;
  return s;
}

export function toDirName(v: SdkVersion): string {
  return `${v.vendor}-${formatVersion(v)}`;
}

/** java 安装目录名 → 版本；不匹配返回 null */
export function parseDirName(dir: string): SdkVersion | null {
  const m = new RegExp(`^(${JAVA_VENDOR_IDS.join('|')})-(.+)$`).exec(dir);
  if (!m || !m[1] || !m[2]) return null;
  try {
    return parseVersion(m[1], m[2]);
  } catch {
    return null;
  }
}

function numericPairwise(a: string | null, b: string | null): number {
  const as = a ? a.split('.') : [];
  const bs = b ? b.split('.') : [];
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined && y !== undefined) return -1;
    if (x !== undefined && y === undefined) return 1;
    const xn = Number(x);
    const yn = Number(y);
    if (Number.isInteger(xn) && Number.isInteger(yn)) {
      if (xn !== yn) return xn - yn > 0 ? 1 : -1;
    } else {
      const c = String(x).localeCompare(String(y));
      if (c !== 0) return c > 0 ? 1 : -1;
    }
  }
  return 0;
}

/** 同 vendor 内比较；major → minor → patch（null 视为 0）→ extra → build 数值分段 */
export function compareVersions(a: SdkVersion, b: SdkVersion): number {
  for (const key of ['major', 'minor'] as const) {
    if (a[key] !== b[key]) return a[key] - b[key] > 0 ? 1 : -1;
  }
  const pa = a.patch ?? 0;
  const pb = b.patch ?? 0;
  if (pa !== pb) return pa - pb > 0 ? 1 : -1;
  const extra = numericPairwise(a.extra, b.extra);
  if (extra !== 0) return extra;
  return numericPairwise(a.build, b.build);
}

/** 预发布标记按文本段和数字段交错比较：rc-10 > rc-2，0.10.pre > 0.2.pre */
function compareVersionTags(a: string, b: string): number {
  const parts = (s: string) => s.match(/\d+|[^\d]+/g) ?? [];
  const as = parts(a);
  const bs = parts(b);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const xn = Number(x);
      const yn = Number(y);
      if (xn !== yn) return xn > yn ? 1 : -1;
      continue;
    }
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 同一组数字上，正式版高于预发布（extra 为空表示正式版）。
 * 只用于把 extra 当作预发布标记的类型（Maven、Flutter）。
 * Java 的 extra 是附加版本段，空 extra 更小，仍用 compareVersions。
 */
export function compareTaggedVersions(a: SdkVersion, b: SdkVersion): number {
  const base = compareVersions({ ...a, extra: null }, { ...b, extra: null });
  if (base !== 0) return base;
  if (a.extra == null && b.extra == null) return 0;
  if (a.extra == null) return 1;
  if (b.extra == null) return -1;
  return compareVersionTags(a.extra, b.extra);
}

/**
 * 版本查询：major（java 装该大版本最新）/ line（go 装该 minor 线最新）/
 * lts（仅 java）/ latest（仅 go）/ full（精确）
 */
export type VersionSpec =
  | { kind: 'major'; major: number }
  | { kind: 'line'; major: number; minor: number }
  | { kind: 'lts' }
  | { kind: 'latest' }
  | { kind: 'full'; version: string };

/** 用户输入解析结果：可带 vendor 前缀（"zulu-21"） */
export interface UserSpec {
  vendor?: VendorId;
  spec: VersionSpec;
}

/** java 版本语法：21 / lts / 21.0.5 / 21.0.5+11，可带 vendor 前缀 */
export function parseUserSpec(input: string): UserSpec {
  let s = input.trim().toLowerCase();
  let vendor: VendorId | undefined;
  const m = new RegExp(`^(${JAVA_VENDOR_IDS.join('|')})-(.+)$`).exec(s);
  if (m && m[1] && m[2]) {
    vendor = m[1];
    s = m[2];
  }
  if (s === 'lts' || s === '--lts') return { vendor, spec: { kind: 'lts' } };
  if (/^\d+$/.test(s)) return { vendor, spec: { kind: 'major', major: Number(s) } };
  if (/^\d+(\.\d+)*(\+[0-9.]+)?$/.test(s)) return { vendor, spec: { kind: 'full', version: s } };
  throw new SdkvmError(`Invalid version: "${input}"`, {
    hint: 'Expected: 21, lts, 21.0.5, 21.0.5+11, or with vendor prefix like temurin-21',
  });
}

// —— go 解析 ——

export const GO_VENDOR_IDS = ['golang'] as const;

/** 解析 go 版本串：容忍 "go"/"golang-" 前缀；基础版（go1.24）patch 为 null */
export function parseGoVersion(vendor: VendorId, input: string): SdkVersion {
  const raw = input.trim();
  const s = raw.replace(/^golang-/i, '').replace(/^go/i, '').replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m || !m[1] || !m[2]) {
    throw new SdkvmError(`Invalid Go version: "${input}"`, {
      hint: 'Expected forms: 1.24, 1.24.5, go1.24.5',
    });
  }
  return {
    vendor,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] !== undefined ? Number(m[3]) : null,
    extra: null,
    build: null,
    raw,
  };
}

/** go 不折叠版本段：1.24 与 1.24.5 都按原样展示 */
export function formatGoVersion(v: SdkVersion): string {
  return v.patch === null ? `${v.major}.${v.minor}` : `${v.major}.${v.minor}.${v.patch}`;
}

/** go 安装目录名 → 版本；不匹配返回 null */
export function parseGoDirName(dir: string): SdkVersion | null {
  const m = new RegExp(`^(${GO_VENDOR_IDS.join('|')})-(.+)$`).exec(dir);
  if (!m || !m[1] || !m[2]) return null;
  try {
    return parseGoVersion(m[1], m[2]);
  } catch {
    return null;
  }
}

/** go 版本语法：1.24（该 minor 线最新）/ 1.24.5（精确）/ latest，可带 golang- 前缀 */
export function parseGoUserSpec(input: string): UserSpec {
  let s = input.trim().toLowerCase();
  let vendor: VendorId | undefined;
  const m = new RegExp(`^(${GO_VENDOR_IDS.join('|')})-(.+)$`).exec(s);
  if (m && m[1] && m[2]) {
    vendor = m[1];
    s = m[2];
  }
  if (s === 'latest') return { vendor, spec: { kind: 'latest' } };
  if (/^\d+\.\d+\.\d+$/.test(s)) return { vendor, spec: { kind: 'full', version: s } };
  const line = /^(\d+)\.(\d+)$/.exec(s);
  if (line && line[1] && line[2]) {
    return { vendor, spec: { kind: 'line', major: Number(line[1]), minor: Number(line[2]) } };
  }
  throw new SdkvmError(`Invalid version: "${input}"`, {
    hint: 'Expected: 1.24, 1.24.5, latest, or with vendor prefix like golang-1.24',
  });
}

// —— flutter 解析 ——

export const FLUTTER_VENDOR_IDS = ['flutter'] as const;

/** 解析 flutter 版本串：容忍 "flutter-" 前缀与旧版 v 前缀（v0.1.6）；prerelease（3.49.0-0.1.pre）→ extra */
export function parseFlutterVersion(vendor: VendorId, input: string): SdkVersion {
  const raw = input.trim();
  const s = raw.replace(/^flutter-/i, '').replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(s);
  if (!m || !m[1] || !m[2] || !m[3]) {
    throw new SdkvmError(`Invalid Flutter version: "${input}"`, {
      hint: 'Expected forms: 3.47, 3.47.5, 3.49.0-0.1.pre, latest',
    });
  }
  return {
    vendor,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    extra: m[4] ?? null,
    build: null,
    raw,
  };
}

/** flutter 不折叠版本段：prerelease 以 -extra 原样展示 */
export function formatFlutterVersion(v: SdkVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch ?? 0}`;
  return v.extra ? `${base}-${v.extra}` : base;
}

/** flutter 安装目录名 → 版本；不匹配返回 null */
export function parseFlutterDirName(dir: string): SdkVersion | null {
  const m = new RegExp(`^(${FLUTTER_VENDOR_IDS.join('|')})-(.+)$`).exec(dir);
  if (!m || !m[1] || !m[2]) return null;
  try {
    return parseFlutterVersion(m[1], m[2]);
  } catch {
    return null;
  }
}

/** flutter 版本语法：3.47（minor 线最新，stable 通道）/ 3.47.5（精确，可含 prerelease）/ latest，可带 flutter- 前缀 */
export function parseFlutterUserSpec(input: string): UserSpec {
  let s = input.trim().toLowerCase();
  let vendor: VendorId | undefined;
  const m = new RegExp(`^(${FLUTTER_VENDOR_IDS.join('|')})-(.+)$`).exec(s);
  if (m && m[1] && m[2]) {
    vendor = m[1];
    s = m[2];
  }
  if (s === 'latest') return { vendor, spec: { kind: 'latest' } };
  if (/^\d+\.\d+\.\d+(-[0-9a-z.\-]+)?$/.test(s)) return { vendor, spec: { kind: 'full', version: s } };
  const line = /^(\d+)\.(\d+)$/.exec(s);
  if (line && line[1] && line[2]) {
    return { vendor, spec: { kind: 'line', major: Number(line[1]), minor: Number(line[2]) } };
  }
  if (/^\d+$/.test(s)) {
    throw new SdkvmError(`Invalid Flutter version: "${input}"`, {
      hint: 'Bare major is ambiguous — use "latest" or a minor line like "3.47"',
    });
  }
  throw new SdkvmError(`Invalid Flutter version: "${input}"`, {
    hint: 'Expected: 3.47, 3.47.5, 3.49.0-0.1.pre, latest, or with vendor prefix like flutter-3.47',
  });
}

// —— node 解析 ——

export const NODE_VENDOR_IDS = ['nodejs'] as const;

/** 解析 node 版本串：容忍 "nodejs-"/"node-"/"v" 前缀 */
export function parseNodeVersion(vendor: VendorId, input: string): SdkVersion {
  const raw = input.trim();
  const s = raw.replace(/^nodejs-/i, '').replace(/^node-/i, '').replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (!m || !m[1] || !m[2] || !m[3]) {
    throw new SdkvmError(`Invalid Node.js version: "${input}"`, {
      hint: 'Expected forms: 22, 22.20.0, lts, latest',
    });
  }
  return {
    vendor,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    extra: null,
    build: null,
    raw,
  };
}

/** node 恒三段展示 */
export function formatNodeVersion(v: SdkVersion): string {
  return `${v.major}.${v.minor}.${v.patch ?? 0}`;
}

/** node 安装目录名 → 版本；不匹配返回 null */
export function parseNodeDirName(dir: string): SdkVersion | null {
  const m = new RegExp(`^(${NODE_VENDOR_IDS.join('|')})-(.+)$`).exec(dir);
  if (!m || !m[1] || !m[2]) return null;
  try {
    return parseNodeVersion(m[1], m[2]);
  } catch {
    return null;
  }
}

/** node 版本语法：22（major 线最新）/ lts / latest / 22.20.0（精确），可带 nodejs-/node- 前缀 */
export function parseNodeUserSpec(input: string): UserSpec {
  let s = input.trim().toLowerCase();
  let vendor: VendorId | undefined;
  const m = /^(nodejs|node)-(.+)$/.exec(s);
  if (m && m[2]) {
    vendor = 'nodejs';
    s = m[2];
  }
  if (s === 'latest') return { vendor, spec: { kind: 'latest' } };
  if (s === 'lts' || s === '--lts') return { vendor, spec: { kind: 'lts' } };
  if (/^\d+\.\d+\.\d+$/.test(s)) return { vendor, spec: { kind: 'full', version: s } };
  if (/^\d+$/.test(s)) return { vendor, spec: { kind: 'major', major: Number(s) } };
  if (/^\d+\.\d+$/.test(s)) {
    throw new SdkvmError(`Invalid Node.js version: "${input}"`, {
      hint: 'Node lines are major-only — use "22" or a full version like "22.20.0"',
    });
  }
  throw new SdkvmError(`Invalid Node.js version: "${input}"`, {
    hint: 'Expected: 22, 22.20.0, lts, latest, or with vendor prefix like nodejs-22.20.0',
  });
}

// —— maven 解析 ——

export const MAVEN_VENDOR_IDS = ['maven'] as const;

/** 解析 maven 版本串：容忍 "maven-" / "v" 前缀；限定符（4.0.0-rc-4）→ extra */
export function parseMavenVersion(vendor: VendorId, input: string): SdkVersion {
  const raw = input.trim();
  const s = raw.replace(/^maven-/i, '').replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(s);
  if (!m || !m[1] || !m[2] || !m[3]) {
    throw new SdkvmError(`Invalid Maven version: "${input}"`, {
      hint: 'Expected forms: 3, 3.9, 3.9.9, 4.0.0-rc-4, latest',
    });
  }
  return {
    vendor,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    extra: m[4] ?? null,
    build: null,
    raw,
  };
}

/** maven 恒三段展示；限定符以 -extra 原样接上 */
export function formatMavenVersion(v: SdkVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch ?? 0}`;
  return v.extra ? `${base}-${v.extra}` : base;
}

/** maven 安装目录名 → 版本；不匹配返回 null */
export function parseMavenDirName(dir: string): SdkVersion | null {
  const m = new RegExp(`^(${MAVEN_VENDOR_IDS.join('|')})-(.+)$`).exec(dir);
  if (!m || !m[1] || !m[2]) return null;
  try {
    return parseMavenVersion(m[1], m[2]);
  } catch {
    return null;
  }
}

/**
 * maven 版本语法：3（major 最新稳定）/ 3.9（minor 线最新稳定）/ 3.9.9（精确）/
 * 4.0.0-rc-4（精确预发布）/ latest，可带 maven- 前缀。无 lts。
 */
export function parseMavenUserSpec(input: string): UserSpec {
  let s = input.trim().toLowerCase();
  let vendor: VendorId | undefined;
  const m = /^(maven)-(.+)$/.exec(s);
  if (m && m[2]) {
    vendor = 'maven';
    s = m[2];
  }
  if (s === 'latest') return { vendor, spec: { kind: 'latest' } };
  if (s === 'lts' || s === '--lts') {
    throw new SdkvmError(`Invalid Maven version: "${input}"`, {
      hint: 'Maven has no lts alias — use "3", "3.9", "3.9.9", or "latest"',
    });
  }
  if (/^\d+\.\d+\.\d+(-[0-9a-z.\-]+)?$/.test(s)) return { vendor, spec: { kind: 'full', version: s } };
  const line = /^(\d+)\.(\d+)$/.exec(s);
  if (line && line[1] && line[2]) {
    return { vendor, spec: { kind: 'line', major: Number(line[1]), minor: Number(line[2]) } };
  }
  if (/^\d+$/.test(s)) return { vendor, spec: { kind: 'major', major: Number(s) } };
  throw new SdkvmError(`Invalid Maven version: "${input}"`, {
    hint: 'Expected: 3, 3.9, 3.9.9, 4.0.0-rc-4, latest, or with vendor prefix like maven-3.9.9',
  });
}

// —— miniconda 解析 ——

export const MINICONDA_VENDOR_IDS = ['miniconda'] as const;

const MINICONDA_VERSION_HINT =
  'Expected forms: 26, 26.7, 26.7.1-1, py313, py313_26.7.1-1, latest';

/** py313 → "3.13"，py39 → "3.9"，py310 → "3.10" */
function pythonExtra(pyMajor: string, pyMinor: string): string {
  return `${pyMajor}.${pyMinor}`;
}

/**
 * 解析 Miniconda 版本。extra 存 Python（"3.13"），build 存发行构建号（"1"）。
 * 接受 py313_26.7.1-1、py39_4.12.0、26.7.1-1、4.12.0，以及 miniconda- 前缀。
 */
export function parseMinicondaVersion(vendor: VendorId, input: string): SdkVersion {
  const raw = input.trim();
  const s = raw.replace(/^miniconda3?-/i, '').replace(/^v/i, '');
  const m = /^(?:py(\d)(\d+)_)?(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(s);
  if (!m || !m[3] || !m[4] || !m[5]) {
    throw new SdkvmError(`Invalid Miniconda version: "${input}"`, {
      hint: MINICONDA_VERSION_HINT,
    });
  }
  return {
    vendor,
    major: Number(m[3]),
    minor: Number(m[4]),
    patch: Number(m[5]),
    extra: m[1] && m[2] ? pythonExtra(m[1], m[2]) : null,
    build: m[6] ?? null,
    raw,
  };
}

/** py313_26.7.1-1；无 Python 标签时只留 4.12.0；无构建号时不补 -0 */
export function formatMinicondaVersion(v: SdkVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch ?? 0}`;
  const withBuild = v.build ? `${base}-${v.build}` : base;
  if (!v.extra) return withBuild;
  const [pyMajor, pyMinor] = v.extra.split('.');
  return `py${pyMajor ?? ''}${pyMinor ?? ''}_${withBuild}`;
}

/** 发行线 key：26.7 */
export function formatMinicondaLine(v: SdkVersion): string {
  return `${v.major}.${v.minor}`;
}

/**
 * full 规格是否命中该 Miniconda 版本。
 * py313：该 Python 的任意安装器；26.7.1-1：该构建里任意 Python；
 * py313_26.7.1：该 Python 的任意构建；py313_26.7.1-1：精确。
 */
export function minicondaMatchesFull(installed: SdkVersion, specVersion: string): boolean {
  const pyOnly = /^py(\d)(\d+)$/.exec(specVersion);
  if (pyOnly?.[1] && pyOnly[2]) return installed.extra === `${pyOnly[1]}.${pyOnly[2]}`;
  let want: SdkVersion;
  try {
    want = parseMinicondaVersion(installed.vendor || 'miniconda', specVersion);
  } catch {
    return false;
  }
  const matchPython = specVersion.startsWith('py');
  const matchBuild = /-\d+$/.test(specVersion);
  return (
    installed.major === want.major &&
    installed.minor === want.minor &&
    (installed.patch ?? 0) === (want.patch ?? 0) &&
    (!matchBuild || installed.build === want.build) &&
    (!matchPython || installed.extra === want.extra)
  );
}

/** miniconda 安装目录名 → 版本；不匹配返回 null */
export function parseMinicondaDirName(dir: string): SdkVersion | null {
  const m = new RegExp(`^(${MINICONDA_VENDOR_IDS.join('|')})-(.+)$`).exec(dir);
  if (!m || !m[1] || !m[2]) return null;
  try {
    return parseMinicondaVersion(m[1], m[2]);
  } catch {
    return null;
  }
}

/**
 * miniconda 版本语法：26（该 major 最新）/ 26.7（minor 线最新）/
 * 26.7.1-1（该构建最高 Python）/ py313（该 Python 最新）/
 * py313_26.7.1-1（精确）/ latest。可带 miniconda- 前缀。无 lts。
 */
export function parseMinicondaUserSpec(input: string): UserSpec {
  let s = input.trim().toLowerCase();
  let vendor: VendorId | undefined;
  const prefixed = /^(miniconda)-(.+)$/.exec(s);
  if (prefixed && prefixed[2]) {
    vendor = 'miniconda';
    s = prefixed[2];
  }
  if (s === 'latest') return { vendor, spec: { kind: 'latest' } };
  if (s === 'lts' || s === '--lts') {
    throw new SdkvmError(`Invalid Miniconda version: "${input}"`, {
      hint: `Miniconda has no lts alias — use ${MINICONDA_VERSION_HINT.replace('Expected forms: ', '')}`,
    });
  }
  if (/^py\d{2,}$/.test(s)) return { vendor, spec: { kind: 'full', version: s } };
  if (/^(?:py\d{2,}_)?\d+\.\d+\.\d+(?:-\d+)?$/.test(s)) {
    parseMinicondaVersion(vendor ?? 'miniconda', s);
    return { vendor, spec: { kind: 'full', version: s } };
  }
  const line = /^(\d+)\.(\d+)$/.exec(s);
  if (line && line[1] && line[2]) {
    return { vendor, spec: { kind: 'line', major: Number(line[1]), minor: Number(line[2]) } };
  }
  if (/^\d+$/.test(s)) return { vendor, spec: { kind: 'major', major: Number(s) } };
  throw new SdkvmError(`Invalid Miniconda version: "${input}"`, {
    hint: MINICONDA_VERSION_HINT,
  });
}

// —— python（CPython / python-build-standalone）解析 ——

export const PYTHON_VENDOR_IDS = ['cpython'] as const;

const PYTHON_VERSION_HINT = 'Expected forms: 3, 3.12, 3.12.7, 3.14.0rc2, latest';

/** 预发布标记：a1 / b3 / rc2。稳定版没有这段。PEP 440：a < b < rc < 正式版。 */
const PYTHON_PRE = '(?:a|b|rc)\\d+';
const PYTHON_VERSION_RE = new RegExp(`^(\\d+)\\.(\\d+)\\.(\\d+)(${PYTHON_PRE})?$`);
const PYTHON_PRE_RE = /^(a|b|rc)(\d+)$/;

/**
 * 解析 CPython 版本。extra 存预发布标记（"rc2"），build 留空。
 * 构建日期 +20260924 不属于版本。接受 cpython- / v 前缀。
 */
export function parsePythonVersion(vendor: VendorId, input: string): SdkVersion {
  const raw = input.trim();
  const s = raw.replace(/^cpython-/i, '').replace(/^v/i, '');
  const m = PYTHON_VERSION_RE.exec(s);
  if (!m || !m[1] || !m[2] || !m[3]) {
    throw new SdkvmError(`Invalid Python version: "${input}"`, {
      hint: PYTHON_VERSION_HINT,
    });
  }
  return {
    vendor,
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    extra: m[4] ?? null,
    build: null,
    raw,
  };
}

/** 3.12.7；预发布直接接在补丁后：3.14.0rc2 */
export function formatPythonVersion(v: SdkVersion): string {
  const base = `${v.major}.${v.minor}.${v.patch ?? 0}`;
  return v.extra ? `${base}${v.extra}` : base;
}

/** 稳定版没有 extra。预发布不参与 3 / 3.12 / latest。 */
export function isPythonStable(v: SdkVersion): boolean {
  return v.extra == null;
}

/**
 * 同一组数字里，正式版比预发布新（3.14.0 > 3.14.0rc2）。
 * 预发布之间按 a < b < rc，序号按数值（rc2 < rc10）。
 * 共用的 compareVersions 把空 extra 当成更小，会把 rc 排到正式版后面。
 */
export function comparePythonVersions(a: SdkVersion, b: SdkVersion): number {
  const base = compareVersions({ ...a, extra: null, build: null }, { ...b, extra: null, build: null });
  if (base !== 0) return base;
  if (a.extra == null && b.extra == null) return 0;
  if (a.extra == null) return 1;
  if (b.extra == null) return -1;
  const ar = PYTHON_PRE_RE.exec(a.extra);
  const br = PYTHON_PRE_RE.exec(b.extra);
  const ak = ar?.[1] === 'rc' ? 2 : ar?.[1] === 'b' ? 1 : 0;
  const bk = br?.[1] === 'rc' ? 2 : br?.[1] === 'b' ? 1 : 0;
  if (ak !== bk) return ak > bk ? 1 : -1;
  const an = Number(ar?.[2] ?? 0);
  const bn = Number(br?.[2] ?? 0);
  if (an !== bn) return an > bn ? 1 : -1;
  return 0;
}

/** python 安装目录名 → 版本；不匹配返回 null */
export function parsePythonDirName(dir: string): SdkVersion | null {
  const m = new RegExp(`^(${PYTHON_VENDOR_IDS.join('|')})-(.+)$`).exec(dir);
  if (!m || !m[1] || !m[2]) return null;
  try {
    return parsePythonVersion(m[1], m[2]);
  } catch {
    return null;
  }
}

/**
 * python 版本语法：3（该 major 最新稳定）/ 3.12（minor 线最新稳定）/
 * 3.12.7（精确）/ 3.14.0rc2（精确预发布）/ latest。可带 cpython- 前缀。无 lts。
 */
export function parsePythonUserSpec(input: string): UserSpec {
  let s = input.trim().toLowerCase();
  let vendor: VendorId | undefined;
  const prefixed = /^(cpython)-(.+)$/.exec(s);
  if (prefixed && prefixed[2]) {
    vendor = 'cpython';
    s = prefixed[2];
  }
  if (s === 'latest') return { vendor, spec: { kind: 'latest' } };
  if (s === 'lts' || s === '--lts') {
    throw new SdkvmError(`Invalid Python version: "${input}"`, {
      hint: 'Python has no lts alias — use "3", "3.12", "3.12.7", or "latest"',
    });
  }
  if (PYTHON_VERSION_RE.test(s)) {
    return { vendor, spec: { kind: 'full', version: s } };
  }
  const line = /^(\d+)\.(\d+)$/.exec(s);
  if (line && line[1] && line[2]) {
    return { vendor, spec: { kind: 'line', major: Number(line[1]), minor: Number(line[2]) } };
  }
  if (/^\d+$/.test(s)) return { vendor, spec: { kind: 'major', major: Number(s) } };
  throw new SdkvmError(`Invalid Python version: "${input}"`, {
    hint: PYTHON_VERSION_HINT,
  });
}
