import fs from 'node:fs';
import path from 'node:path';
import type { SdkVersion } from './version.js';
import { paths } from './paths.js';
import { SdkvmError } from '../util/errors.js';
import { readCurrent } from '../fs/link.js';
import { loadConfig } from './config.js';
import { getSdkType } from '../sdk/index.js';
import type { SdkTypeId } from '../sdk/types.js';
import { cmdPath } from '../cli/cmdname.js';

export interface InstalledSdk {
  type: SdkTypeId;
  version: SdkVersion;
  dirPath: string;
  /** 环境语义路径（JAVA_HOME / GO_HOME 等指向它；java macOS bundle → Contents/Home） */
  home: string;
}

/** 进行中的半成品对 registry 不可见。settled 表示安装已完成，只是标记文件删不掉。 */
function incompleteHidesInstall(dirPath: string): boolean {
  const marker = `${dirPath}.incomplete`;
  if (!fs.existsSync(marker)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8')) as { settled?: unknown };
    return parsed?.settled !== true;
  } catch {
    return true;
  }
}

/** 扫描安装根目录（如 ~/.sdkvm/jdks/），按版本升序 */
export function listInstalled(type: SdkTypeId): InstalledSdk[] {
  const spec = getSdkType(type);
  const root = paths.sdks(type);
  if (!fs.existsSync(root)) return [];
  const result: InstalledSdk[] = [];
  for (const name of fs.readdirSync(root)) {
    const version = spec.parseDirName(name);
    if (!version) continue;
    const dirPath = path.join(root, name);
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
    } catch {
      continue; // 扫描期间被并发卸载删除
    }
    // 进行中的 .incomplete 是半成品，不可见。settled:true 表示安装已成功、只是标记删不掉。
    if (incompleteHidesInstall(dirPath)) continue;
    result.push({ type, version, dirPath, home: spec.locateHome(dirPath) });
  }
  // 版本相同的两条（java 跨 vendor 并存）用 vendor 名决出确定序，
  // 否则 `use 21` 选谁取决于 readdir 顺序（文件系统不保证字母序）
  result.sort(
    (a, b) => spec.compareVersions(a.version, b.version) || a.version.vendor.localeCompare(b.version.vendor),
  );
  return result;
}

/** 当前 current 指向的已安装 SDK（无链接或悬空返回 null） */
export function currentSdk(type: SdkTypeId): InstalledSdk | null {
  const current = readCurrent(type);
  if (!current) return null;
  // 比较必须宽容文件系统等价拼写：
  // - Windows 大小写不敏感：两次会话用不同大小写设置 SDKVM_HOME 时，
  //   逐字节比较会把明明指向自己的 current 判成不匹配，跳过 rc/注册表清理
  // - macOS 的 /tmp 是 /private/tmp 的符号链接：链接内容与 readdir 拼出的路径
  //   拼写不同（use 时怎么写、uninstall 时怎么读取决于 SDKVM_HOME 的写法）
  // realpath 失败（目标已删）时退回原拼写，别把悬空链接当匹配
  const norm = (p: string): string => {
    const lowered = process.platform === 'win32' ? p.toLowerCase() : p;
    try {
      return fs.realpathSync(lowered);
    } catch {
      return lowered;
    }
  };
  return (
    listInstalled(type).find(
      (j) =>
        norm(j.home) === norm(current) ||
        norm(j.dirPath) === norm(current) ||
        norm(current).startsWith(norm(j.dirPath) + path.sep),
    ) ?? null
  );
}

/**
 * 按用户输入匹配已安装版本：
 * java: 21 → 该 major 最新 / lts / 21.0.5 前缀匹配；go: 1.24 → 该 minor 线最新 / latest / 1.24.5 精确。
 * miniconda full：py313、26.7.1-1 走 matchesFull。
 * python / maven / flutter 的 major、line、latest 跳过预发布。可带 vendor 前缀。
 */
export function findInstalled(type: SdkTypeId, specInput: string, vendorArg?: string): InstalledSdk {
  const spec = getSdkType(type);
  const { vendor: specVendor, spec: parsed } = spec.parseUserSpec(specInput);
  // --vendor 与输入前缀同源；前者没经过 toLowerCase（parseUserSpec 内部有），
  // 大小写不一（--vendor Corretto）会静默过滤成空集
  const vendor = (vendorArg ?? specVendor)?.toLowerCase();
  const all = listInstalled(type);
  const candidates = vendor ? all.filter((j) => j.version.vendor === vendor) : all;

  let matched: InstalledSdk[];
  const loose = (j: InstalledSdk) => (spec.matchesLoose ? spec.matchesLoose(j.version) : true);
  if (parsed.kind === 'major') {
    matched = candidates.filter((j) => loose(j) && j.version.major === parsed.major);
  } else if (parsed.kind === 'line') {
    matched = candidates.filter(
      (j) => loose(j) && j.version.major === parsed.major && j.version.minor === parsed.minor,
    );
  } else if (parsed.kind === 'lts') {
    const isLtsMajor = spec.isLtsMajor;
    if (!spec.supportsLts || !isLtsMajor) {
      throw new SdkvmError(`${spec.label} has no LTS releases`, {
        hint: `Try: ${cmdPath(type)} install latest`,
      });
    }
    matched = candidates.filter((j) => isLtsMajor(j.version.major));
  } else if (parsed.kind === 'latest') {
    matched = candidates.filter(loose); // 排序后取最后一个即最新；预发布可由 matchesLoose 排除
  } else {
    const v = parsed.version;
    matched = candidates.filter((j) => {
      if (spec.matchesFull) return spec.matchesFull(j.version, v);
      const f = spec.formatVersion(j.version);
      // 反向前缀：wanted 带 build 而已装目录不带（zulu 的 build 在 distro_version，不进目录名）
      if (f === v || f.startsWith(`${v}+`) || f.startsWith(`${v}.`) || v.startsWith(`${f}+`)) return true;
      // formatVersion 会把 X.0.0 折叠成 X：目录显示 "21" 时输入 "21.0"/"21.0.0" 也应命中。
      // 输入带 build 时上面四条已判定（命中或不同构建）——norm 会把 build 一并抹掉，
      // 不能让 "21.0.5+11" 的请求被匹配到 21.0.5+9 的安装上
      const norm = (s: string) => (s.split('+')[0] ?? s).replace(/(\.0)+$/, '');
      // 数值段归一比较：corretto 8 的目录名补零（8.504.01.1），用户按未补零的
      // 原样输入 use 也应命中；段数相同且逐段数值相等才算同名
      const numericEq = (a: string, b: string): boolean => {
        const as = (a.split('+')[0] ?? a).split('.');
        const bs = (b.split('+')[0] ?? b).split('.');
        return as.length === bs.length && as.every((seg, i) => /^\d+$/.test(seg) && Number(seg) === Number(bs[i]));
      };
      return !v.includes('+') && (norm(f) === norm(v) || numericEq(f, v));
    });
  }

  if (matched.length === 0) {
    const installedList = all
      .map((j) => `  ${j.version.vendor}-${spec.formatVersion(j.version)}`)
      .join('\n');
    const want = parsed.kind === 'full' ? parsed.version : specInput;
    // lts 筛选用内置静态表（离线可用），install 走厂商 API 动态解析：新 LTS 发布后
    // 表未更新时会出现"装得上 use 不了"——已装里最大的 major 超过静态表已知的最大
    // LTS major 时点破（不依赖用户恰好装过某个已知 LTS）
    const ltsMajorOf = spec.supportsLts ? spec.isLtsMajor : undefined;
    const installedMaxMajor = all.length > 0 ? Math.max(...all.map((j) => j.version.major)) : 0;
    let knownMaxLts = 0;
    for (let m = 1; m <= installedMaxMajor; m += 1) {
      if (ltsMajorOf?.(m)) knownMaxLts = m;
    }
    const newerThanKnownLts = parsed.kind === 'lts' && knownMaxLts > 0 && installedMaxMajor > knownMaxLts;
    throw new SdkvmError(`No installed ${spec.label} matches "${specInput}"`, {
      hint:
        (all.length > 0 ? `Installed:\n${installedList}\n` : '') +
        (newerThanKnownLts
          ? 'A newer non-LTS-per-table major is installed — the built-in LTS table may lag behind a newly released LTS; use the exact version from the list above.\n'
          : '') +
        `Install one first: ${cmdPath(type)} install ${want}`,
    });
  }
  // 同一版本号跨 vendor 并存（temurin-21.0.5 与 corretto-21.0.5）时优先默认 vendor，
  // 否则选谁取决于 localeCompare 的字母序，与 defaultVendor 配置脱节
  let pick = matched[matched.length - 1] as InstalledSdk;
  if (matched.length > 1 && vendor == null) {
    const tied = matched.filter((m) => spec.compareVersions(m.version, pick.version) === 0);
    if (tied.length > 1) {
      const preferred = tied.find((m) => m.version.vendor === loadConfig().defaultVendor);
      if (preferred) pick = preferred;
    }
  }
  return pick;
}
