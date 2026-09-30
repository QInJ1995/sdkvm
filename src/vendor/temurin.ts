import type { ReleaseLine, ResolvedArtifact, Vendor } from './types.js';
import type { VendorPlatform } from './types.js';
import { HttpError, httpJson } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { formatVersion, parseVersion, type SdkVersion } from '../core/version.js';

const API = 'https://api.adoptium.net';

interface AvailableReleases {
  available_releases: number[];
  available_lts_releases: number[];
}

interface LatestAsset {
  binary?: {
    package?: {
      link?: unknown;
      checksum?: unknown;
    };
  };
}

/**
 * major 线最新版的下载 URL 与官方 sha256。
 * 走 assets API（api.adoptium.net）而非 GitHub `.json` 旁路：
 * 镜像模式下 GitHub 不可达是常态，镜像又不托管 `.json`，校验会无路可走。
 */
async function resolveLatestAsset(
  major: number,
  os: string,
  arch: string,
): Promise<{ downloadUrl: string; sha256: string | null }> {
  const url = `${API}/v3/assets/latest/${major}/hotspot?os=${os}&architecture=${arch}&image_type=jdk`;
  let data: unknown;
  try {
    data = await httpJson<unknown>(url);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new SdkvmError(`No Temurin JDK ${major} build for ${os}/${arch}`, {
        hint: 'This platform is not published for that major. Try another vendor, for example: sdkvm java install 8 --vendor zulu',
      });
    }
    throw err;
  }
  if (!Array.isArray(data) || data.length === 0) {
    // 200 + [] 与 404 同义（mac/aarch64 的 JDK 8 就是这样：Temurin 没发过该组合）
    throw new SdkvmError(`No Temurin JDK ${major} build for ${os}/${arch}`, {
      hint: 'This platform is not published for that major. Try another vendor, for example: sdkvm java install 8 --vendor zulu',
    });
  }
  const pkg = (data[0] as LatestAsset)?.binary?.package;
  const link = typeof pkg?.link === 'string' ? pkg.link : '';
  if (!link.startsWith('https://')) {
    throw new SdkvmError(`Adoptium API returned no download link for JDK ${major}`);
  }
  const checksum = typeof pkg?.checksum === 'string' && /^[0-9a-f]{64}$/i.test(pkg.checksum)
    ? pkg.checksum.toLowerCase()
    : null;
  return { downloadUrl: link, sha256: checksum };
}

/**
 * GitHub release URL → 版本串。
 * 现代标签 jdk-21.0.12.1%2B1 → 21.0.12.1+1。
 * JDK 8 仍是 jdk8u504-b01，没有 jdk- 前缀，也没有 %2B。
 */
function versionFromGithubUrl(url: string): string {
  const modern = /\/download\/jdk-([^/%]+(?:%2B[^/%]+)?)\//i.exec(url);
  if (modern?.[1]) return decodeURIComponent(modern[1]);
  const legacy = /\/download\/jdk8u(\d+)-b(\d+)\//i.exec(url);
  if (legacy?.[1] && legacy?.[2]) {
    return `8.0.${Number(legacy[1])}+${Number(legacy[2])}`;
  }
  throw new SdkvmError(`Cannot parse version from Adoptium URL: ${url}`);
}

/** JDK 8 资源名是 8u504b01，标签是 jdk8u504-b01。build 不足两位时补零。 */
function jdk8LegacyNames(v: SdkVersion): { tag: string; token: string } | null {
  if (v.major !== 8 || v.minor !== 0 || v.patch == null || v.patch <= 0 || v.extra || v.build == null) {
    return null;
  }
  const build = Number(v.build);
  if (!Number.isInteger(build) || build < 0) return null;
  const padded = String(build).padStart(2, '0');
  return { tag: `jdk8u${v.patch}-b${padded}`, token: `8u${v.patch}b${padded}` };
}

function githubAssetUrl(version: string, os: string, arch: string): string {
  const v = parseVersion('temurin', version);
  const ext = os === 'windows' ? 'zip' : 'tar.gz';
  const legacy = jdk8LegacyNames(v);
  if (legacy) {
    const file = `OpenJDK8U-jdk_${arch}_${os}_hotspot_${legacy.token}.${ext}`;
    return `https://github.com/adoptium/temurin8-binaries/releases/download/${legacy.tag}/${file}`;
  }
  if (v.major === 8) {
    // JDK 8 的 release 都是 8uNNN-bNN 形式：不带 build 号（8.0.504）或带 extra 段的写法
    // 都拼不出真实存在的 asset，与其等到下载 404，不如在解析阶段给出版本语法提示。
    throw new SdkvmError(`Temurin JDK 8 needs an update+build version, got "${version}"`, {
      hint: 'Use e.g. 8.0.504+6 (see https://github.com/adoptium/temurin8-binaries/tags), or "sdkvm java install 8" for the latest 8',
    });
  }
  const major = v.major;
  // 文件名直接用用户输入的版本正文：formatVersion 会把 21.0.0 折叠成 21，拼出错URL
  const underscored = version.replace('+', '_');
  const file = `OpenJDK${major}U-jdk_${arch}_${os}_hotspot_${underscored}.${ext}`;
  return `https://github.com/adoptium/temurin${major}-binaries/releases/download/jdk-${encodeURIComponent(version)}/${file}`;
}

async function fetchAvailable(): Promise<AvailableReleases> {
  const data = await httpJson<unknown>(`${API}/v3/info/available_releases`);
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as AvailableReleases).available_releases) ||
    !Array.isArray((data as AvailableReleases).available_lts_releases)
  ) {
    throw new SdkvmError('Adoptium API returned an unexpected available_releases payload');
  }
  return data as AvailableReleases;
}

async function resolveMajor(major: number, platform: VendorPlatform): Promise<ResolvedArtifact> {
  const { downloadUrl, sha256 } = await resolveLatestAsset(major, platform.os, platform.arch);
  const version = versionFromGithubUrl(downloadUrl);
  return buildArtifact(version, platform, downloadUrl, sha256);
}

function buildArtifact(
  version: string,
  platform: VendorPlatform,
  downloadUrl: string,
  expectedSha?: string | null,
): ResolvedArtifact {
  const v = parseVersion('temurin', version);
  const archive = platform.os === 'windows' ? 'zip' : 'tar.gz';
  return {
    vendorId: 'temurin',
    version: v,
    dirName: `temurin-${formatVersion(v)}`,
    displayName: `Temurin ${formatVersion(v)}`,
    downloadUrl,
    // 预取到 API 哈希时直接用；否则回退 GitHub `.json` 旁路（full 规格路径）
    checksum: expectedSha
      ? { kind: 'sha256', expected: expectedSha }
      : { kind: 'sha256', url: `${downloadUrl}.json` },
    archive,
  };
}

export const temurinVendor: Vendor = {
  id: 'temurin',
  label: 'Adoptium Temurin',
  sdk: 'java',
  supportsFullVersionList: true,

  async listMajors(): Promise<ReleaseLine[]> {
    const data = await fetchAvailable();
    return data.available_releases
      .slice()
      .sort((a, b) => a - b)
      .map((major) => ({ key: String(major), lts: data.available_lts_releases.includes(major) }));
  },

  async resolve(spec, platform): Promise<ResolvedArtifact> {
    if (spec.kind === 'major') {
      return resolveMajor(spec.major, platform);
    }
    if (spec.kind === 'lts') {
      const data = await fetchAvailable();
      const ltsMajors = data.available_releases.filter((m) =>
        data.available_lts_releases.includes(m),
      );
      if (ltsMajors.length === 0) throw new SdkvmError('No Temurin LTS release found');
      const latest = Math.max(...ltsMajors);
      return resolveMajor(latest, platform);
    }
    if (spec.kind !== 'full') {
      // java 语法不会产出 line/latest（go 专用），防御性拒绝
      throw new SdkvmError(`Unsupported version spec for Temurin: ${spec.kind}`);
    }
    // 精确版本：直接构造 GitHub asset URL（assets/version 端点已废弃，404 由下载环节报错）
    const url = githubAssetUrl(spec.version, platform.os, platform.arch);
    return buildArtifact(spec.version, platform, url);
  },
};
