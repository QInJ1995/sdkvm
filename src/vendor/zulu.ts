import fs from 'node:fs';
import type { ReleaseLine, ResolvedArtifact, Vendor, VendorPlatform } from './types.js';
import { httpFetch } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { LTS_MAJORS, compareVersions, formatVersion, parseVersion } from '../core/version.js';
import { detectPlatform } from '../core/platform.js';
import { temurinVendor } from './temurin.js';
import { cmdPath } from '../cli/cmdname.js';
import { log } from '../ui/log.js';

const API = 'https://api.azul.com/metadata/v1';

/** os/arch → Azul API 参数 */
function azulParams(platform: VendorPlatform): { os: string; arch: string } {
  return {
    os: platform.os === 'mac' ? 'macos' : platform.os,
    arch: platform.arch === 'aarch64' ? 'arm' : 'x64',
  };
}

interface ZuluPackage {
  name: string;
  download_url: string;
  java_version: number[];
  distro_version: number[];
  package_uuid?: string;
  sha256_hash?: string;
}

/**
 * major（如 "21"）：匹配该大版本。
 * 完整/部分版本：精确相等，或带段边界的前缀（"21.0.1" 可匹配 "21.0.1.2"，不匹配 "21.0.10"）。
 * "+build" 段先剥离：Azul 的 build 号在 distro_version，不在 java_version 里。
 */
export function zuluVersionMatches(javaVersion: number[], wantedRaw: string): boolean {
  if (!wantedRaw) return true;
  const wanted = wantedRaw.split('+')[0] ?? wantedRaw;
  if (!wanted) return true;
  const actual = javaVersion.join('.');
  if (actual === wanted) return true;
  if (/^\d+$/.test(wanted)) return javaVersion[0] === Number(wanted);
  return actual.startsWith(`${wanted}.`);
}

/** 数字数组逐段比较（distro_version 决胜用）：[21,52,203] < [21,53,1] */
function compareNumericArrays(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 候选升序：java_version 为主，同 java_version 的多个构建以 distro_version 决胜 */
function compareZuluPackages(a: ZuluPackage, b: ZuluPackage): number {
  const va = parseVersion('zulu', a.java_version.join('.'));
  const vb = parseVersion('zulu', b.java_version.join('.'));
  const byJava = compareVersions(va, vb);
  if (byJava !== 0) return byJava;
  return compareNumericArrays(a.distro_version, b.distro_version);
}

/**
 * 宿主 libc（仅 linux 相关）：检测到 musl loader（Alpine 等）则 musl，否则 glibc。
 * musl 与 glibc 构建互不兼容——按宿主选择，而不是一刀切排除 musl。
 */
function hostLibc(platform: VendorPlatform): 'glibc' | 'musl' {
  if (platform.os !== 'linux') return 'glibc';
  const markers = [
    '/lib/ld-musl-x86_64.so.1',
    '/lib/ld-musl-aarch64.so.1',
    '/etc/alpine-release',
  ];
  return markers.some((m) => fs.existsSync(m)) ? 'musl' : 'glibc';
}

/** 客户端过滤：只要普通 ca-jdk 构建（API 的过滤参数不可靠：会漏进 crac/fx-jre） */
function pickPlainJdk(
  packages: ZuluPackage[],
  platform: VendorPlatform,
  versionPrefix?: string,
): ZuluPackage | null {
  const ext = platform.os === 'windows' ? '.zip' : '.tar.gz';
  const wanted = versionPrefix ?? '';
  const wantMusl = hostLibc(platform) === 'musl';
  const candidates = packages.filter((p) => {
    if (!/^zulu[\d.]+-ca-jdk[\d.]*-/i.test(p.name)) return false;
    if (!p.name.endsWith(ext)) return false;
    // musl 变体与 glibc 同版本同排序权重，不按 libc 过滤会选错（glibc 主机选到 musl，
    // musl 主机选到跑不起来的 glibc）
    if (/musl/i.test(p.name) !== wantMusl) return false;
    if (wanted && !zuluVersionMatches(p.java_version, wanted)) return false;
    return true;
  });
  candidates.sort(compareZuluPackages);
  return candidates[candidates.length - 1] ?? null;
}

/** Azul 默认每页 50 条。JDK 8 有五百多条包，只读第一页会漏掉较旧的精确版本。 */
const ZULU_PAGE_SIZE = 1000;
const ZULU_MAX_PAGES = 20;

function nextZuluPage(header: string | null): number | null {
  if (!header) return null;
  try {
    const parsed = JSON.parse(header) as { next_page?: unknown };
    return typeof parsed.next_page === 'number' && parsed.next_page > 0 ? parsed.next_page : null;
  } catch {
    return null;
  }
}

async function queryPackages(
  javaVersion: string,
  platform: VendorPlatform,
): Promise<ZuluPackage[]> {
  const { os, arch } = azulParams(platform);
  const out: ZuluPackage[] = [];
  let page = 1;
  const seen = new Set<number>();
  while (!seen.has(page) && seen.size < ZULU_MAX_PAGES) {
    seen.add(page);
    const url =
      `${API}/zulu/packages/?java_version=${encodeURIComponent(javaVersion)}&os=${os}&arch=${arch}` +
      `&hw_bitness=64&release_status=ga&page_size=${ZULU_PAGE_SIZE}&page=${page}`;
    const res = await httpFetch(url, { headers: { accept: 'application/json' } });
    const data = (await res.json()) as unknown;
    if (Array.isArray(data)) out.push(...(data as ZuluPackage[]));
    const next = nextZuluPage(res.headers.get('x-pagination'));
    if (next == null || next === page) break;
    page = next;
  }
  return out;
}

/**
 * 列目录接口不再返回 sha256_hash，哈希在包详情上。
 * 详情失败时保持缺失，安装仍走尽力校验，不因此中断。
 */
async function hydrateChecksum(pkg: ZuluPackage): Promise<ZuluPackage> {
  if (pkg.sha256_hash || !pkg.package_uuid) return pkg;
  try {
    const res = await httpFetch(`${API}/zulu/packages/${pkg.package_uuid}`, {
      headers: { accept: 'application/json' },
    });
    const detail = (await res.json()) as { sha256_hash?: unknown };
    if (typeof detail.sha256_hash === 'string' && /^[0-9a-f]{64}$/i.test(detail.sha256_hash)) {
      return { ...pkg, sha256_hash: detail.sha256_hash.toLowerCase() };
    }
  } catch {
    // 详情不可达时跳过校验
  }
  return pkg;
}

export const zuluVendor: Vendor = {
  id: 'zulu',
  label: 'Azul Zulu',
  sdk: 'java',
  supportsFullVersionList: true,

  async listMajors(): Promise<ReleaseLine[]> {
    // 用 Adoptium 的 OpenJDK 发布节奏作为 major 全集，逐个探测 Zulu 是否有构建
    const universe = await temurinVendor.listMajors();
    const platform = detectPlatform();
    const failed: string[] = [];
    const results = await Promise.all(
      universe.map(async ({ key }): Promise<ReleaseLine | null> => {
        try {
          const packages = await queryPackages(key, platform);
          const pick = pickPlainJdk(packages, platform);
          if (!pick) return null;
          return { key, lts: LTS_MAJORS.has(Number(key)), latestFullVersion: pick.java_version.join('.') };
        } catch {
          // 静默吞掉会让 ls -r 无声缺行、lts 解析偏错：收集起来统一提示
          failed.push(key);
          return null;
        }
      }),
    );
    if (failed.length > 0) {
      if (failed.length === universe.length) {
        throw new SdkvmError(`Zulu listing failed for all majors (${failed.join(', ')})`);
      }
      log.warn(`Zulu listing failed for majors ${failed.join(', ')}; those lines are hidden`);
    }
    return results.filter((r): r is ReleaseLine => r !== null);
  },

  async resolve(spec, platform): Promise<ResolvedArtifact> {
    if (spec.kind === 'lts') {
      const majors = await this.listMajors();
      const lts = majors.filter((m) => m.lts);
      if (lts.length === 0) throw new SdkvmError('No Zulu LTS release found');
      const latest = lts[lts.length - 1];
      if (!latest) throw new SdkvmError('No Zulu LTS release found');
      return this.resolve({ kind: 'major', major: Number(latest.key) }, platform);
    }
    if (spec.kind !== 'major' && spec.kind !== 'full') {
      // java 语法不会产出 line/latest（go 专用），防御性拒绝
      throw new SdkvmError(`Unsupported version spec for Zulu: ${spec.kind}`);
    }
    const versionPrefix = spec.kind === 'major' ? String(spec.major) : spec.version;
    const major = spec.kind === 'major' ? spec.major : parseVersion('zulu', spec.version).major;
    const packages = await queryPackages(String(major), platform);
    const pick = pickPlainJdk(packages, platform, versionPrefix);
    if (!pick) {
      throw new SdkvmError(`No Zulu JDK build matches "${versionPrefix}"`, {
        hint: `Run \`${cmdPath('java')} ls -r\` to see available versions.`,
      });
    }
    const hashed = await hydrateChecksum(pick);
    const versionStr = hashed.java_version.join('.');
    const v = parseVersion('zulu', versionStr);
    return {
      vendorId: 'zulu',
      version: v,
      dirName: `zulu-${formatVersion(v)}`,
      displayName: `Zulu ${formatVersion(v)}`,
      downloadUrl: hashed.download_url,
      checksum: hashed.sha256_hash
        ? { kind: 'sha256', expected: hashed.sha256_hash }
        : null,
      archive: platform.os === 'windows' ? 'zip' : 'tar.gz',
    };
  },
};
