import type { ReleaseLine, ResolvedArtifact, Vendor, VendorPlatform } from './types.js';
import { httpFetch, httpText, HttpError } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { LTS_MAJORS, formatVersion, parseVersion } from '../core/version.js';
import { detectPlatform } from '../core/platform.js';
import { temurinVendor } from './temurin.js';
import { cmdPath } from '../cli/cmdname.js';
import { log } from '../ui/log.js';

/**
 * Corretto 8 的构建号固定两位：8.504.01.1。
 * Number() 会把 01 收成 1，按收成后的字符串去拼 URL 会 403。
 * 其它 major 没有这条约定，原样返回。
 */
export function canonicalCorrettoVersion(input: string): string {
  const v = parseVersion('corretto', input);
  if (v.major !== 8 || v.patch == null || v.extra == null || v.build != null) return input.trim();
  if (!/^\d+$/.test(v.extra)) return input.trim();
  return `8.${v.minor}.${String(v.patch).padStart(2, '0')}.${v.extra}`;
}

const BASE = 'https://corretto.aws/downloads';

/** latest 重定向入口的文件名（已验证：aarch64-macos / x64-linux / x64-windows） */
function latestFileName(major: number, platform: VendorPlatform): string {
  const osName = platform.os === 'mac' ? 'macos' : platform.os;
  const ext = platform.os === 'windows' ? 'zip' : 'tar.gz';
  return `amazon-corretto-${major}-${platform.arch}-${osName}-jdk.${ext}`;
}

/** resources 直链的文件名（三平台命名规则不同，均已实测验证） */
function resourceFileName(version: string, platform: VendorPlatform): string {
  if (platform.os === 'mac') return `amazon-corretto-${version}-macosx-${platform.arch}.tar.gz`;
  if (platform.os === 'linux') return `amazon-corretto-${version}-linux-${platform.arch}.tar.gz`;
  return `amazon-corretto-${version}-windows-${platform.arch}-jdk.zip`;
}

function resourceUrl(version: string, platform: VendorPlatform): string {
  return `${BASE}/resources/${version}/${resourceFileName(version, platform)}`;
}

async function resolveLatestVersion(major: number, platform: VendorPlatform): Promise<string> {
  const url = `${BASE}/latest/${latestFileName(major, platform)}`;
  let res;
  try {
    res = await httpFetch(url, { redirect: 'manual' });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new SdkvmError(`No Corretto JDK ${major} build for ${platform.os}/${platform.arch}`, {
        hint: `Corretto does not publish every major/platform combination. Run \`${cmdPath('java')} ls -r --vendor corretto\` to see the lines, or try another vendor: ${cmdPath('java')} install ${major} --vendor temurin`,
      });
    }
    throw err;
  }
  if (res.status !== 301 && res.status !== 302 && res.status !== 307 && res.status !== 308) {
    throw new SdkvmError(`Corretto returned ${res.status} for JDK ${major}`);
  }
  const location = res.headers.get('location') ?? '';
  const m = /\/resources\/([^/]+)\//.exec(location);
  if (!m || !m[1]) {
    throw new SdkvmError(`Cannot parse Corretto version from redirect: ${location}`);
  }
  return m[1];
}

/**
 * latest 入口的官方 sha256（裸 hex）。resources 旁路 `.sha256` 已下线（403），
 * major/lts 走 latest 解析时从这里取哈希。两次请求之间 latest 若滚动更新会哈希错位，
 * 表现为校验失败，重试即可（fail-closed）。
 */
async function fetchLatestSha256(major: number, platform: VendorPlatform): Promise<string | null> {
  try {
    const text = await httpText(`${BASE}/latest_sha256/${latestFileName(major, platform)}`);
    const hash = text.trim().split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : null;
  } catch {
    return null;
  }
}

export const correttoVendor: Vendor = {
  id: 'corretto',
  label: 'Amazon Corretto',
  sdk: 'java',
  supportsFullVersionList: false,

  async listMajors(): Promise<ReleaseLine[]> {
    // Corretto 无公开列表 API，且不只发 LTS（22/24/26 等中间版都在线）。
    // 与 Zulu 相同的思路：以 Adoptium 的发布节奏为 major 全集，逐个探测 latest 重定向，
    // 探测不到（该 major/平台没发）就隐藏该行。
    const universe = await temurinVendor.listMajors();
    const platform = detectPlatform();
    const failed: string[] = [];
    const results = await Promise.all(
      universe.map(async ({ key }): Promise<ReleaseLine | null> => {
        try {
          const latest = await resolveLatestVersion(Number(key), platform);
          return { key, lts: LTS_MAJORS.has(Number(key)), latestFullVersion: latest };
        } catch {
          failed.push(key);
          return null;
        }
      }),
    );
    if (failed.length > 0) {
      if (failed.length === universe.length) {
        throw new SdkvmError(`Corretto listing failed for all majors (${failed.join(', ')})`);
      }
      log.warn(`Corretto listing failed for majors ${failed.join(', ')}; those lines are hidden`);
    }
    return results.filter((r): r is ReleaseLine => r !== null);
  },

  async resolve(spec, platform): Promise<ResolvedArtifact> {
    let version: string;
    let majorSha: string | null = null;
    if (spec.kind === 'lts') {
      const latestLts = Math.max(...LTS_MAJORS);
      version = await resolveLatestVersion(latestLts, platform);
      majorSha = await fetchLatestSha256(latestLts, platform);
    } else if (spec.kind === 'major') {
      // 不再预判 major 是否存在：latest 重定向的 404 已给出准确错误
      version = await resolveLatestVersion(spec.major, platform);
      majorSha = await fetchLatestSha256(spec.major, platform);
    } else if (spec.kind === 'full') {
      const v = parseVersion('corretto', spec.version);
      if (v.build != null) {
        throw new SdkvmError(`Corretto versions have no "+build" segment: "${spec.version}"`, {
          hint: `Use the Corretto form like 21.0.8.9.1 (8.504.01.1 for JDK 8), or install by major: ${cmdPath('java')} install ${v.major} --vendor corretto`,
        });
      }
      version = spec.version;
    } else {
      // java 语法不会产出 line/latest（go 专用），防御性拒绝
      throw new SdkvmError(`Unsupported version spec for Corretto: ${spec.kind}`);
    }
    const canonical = canonicalCorrettoVersion(version);
    const v = parseVersion('corretto', canonical);
    const url = resourceUrl(canonical, platform);
    if (spec.kind !== 'full' && !majorSha) {
      // latest_sha256 端点拿不到哈希时无法核对：如实提示，不再挂已下线的 .sha256 死链
      log.warn(`cannot fetch Corretto sha256 for ${canonical}, archive will be installed unverified`);
    }
    return {
      vendorId: 'corretto',
      version: v,
      dirName: `corretto-${formatVersion(v)}`,
      displayName: `Corretto ${formatVersion(v)}`,
      downloadUrl: url,
      // full 历史版本无公开校验旁路（.sha256 已 403）；major/lts 用 latest_sha256 的官方值
      checksum:
        spec.kind !== 'full' && majorSha ? { kind: 'sha256', expected: majorSha } : null,
      archive: platform.os === 'windows' ? 'zip' : 'tar.gz',
    };
  },
};
