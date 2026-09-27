import type { ReleaseLine, ResolvedArtifact, Vendor } from './types.js';
import type { VendorPlatform } from './types.js';
import { HttpError, httpJson, httpFetch } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { formatVersion, parseVersion, type SdkVersion } from '../core/version.js';

const API = 'https://api.adoptium.net';

interface AvailableReleases {
  available_releases: number[];
  available_lts_releases: number[];
}

/** 用 redirect:manual 拿 307 Location（无需真正连 GitHub） */
async function resolveLatestRedirect(
  major: number,
  os: string,
  arch: string,
): Promise<string> {
  const url = `${API}/v3/binary/latest/${major}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`;
  let res: Response;
  try {
    res = await httpFetch(url, { redirect: 'manual' });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      throw new SdkvmError(`No Temurin JDK ${major} build for ${os}/${arch}`, {
        hint: 'This platform is not published for that major. Try another vendor, for example: sdkvm java install 8 --vendor zulu',
      });
    }
    throw err;
  }
  if (res.status !== 302 && res.status !== 307 && res.status !== 308) {
    throw new SdkvmError(`Adoptium API returned ${res.status} for JDK ${major}`);
  }
  const location = res.headers.get('location');
  if (!location) throw new SdkvmError(`Adoptium API returned no redirect for JDK ${major}`);
  return location;
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
  const major = v.major;
  const underscored = formatVersion(v).replace('+', '_');
  const file = `OpenJDK${major}U-jdk_${arch}_${os}_hotspot_${underscored}.${ext}`;
  return `https://github.com/adoptium/temurin${major}-binaries/releases/download/jdk-${encodeURIComponent(version)}/${file}`;
}

async function fetchAvailable(): Promise<AvailableReleases> {
  return httpJson<AvailableReleases>(`${API}/v3/info/available_releases`);
}

async function resolveMajor(major: number, platform: VendorPlatform): Promise<ResolvedArtifact> {
  const location = await resolveLatestRedirect(major, platform.os, platform.arch);
  const version = versionFromGithubUrl(location);
  return buildArtifact(version, platform, location);
}

function buildArtifact(
  version: string,
  platform: VendorPlatform,
  downloadUrl: string,
): ResolvedArtifact {
  const v = parseVersion('temurin', version);
  const archive = platform.os === 'windows' ? 'zip' : 'tar.gz';
  return {
    vendorId: 'temurin',
    version: v,
    dirName: `temurin-${formatVersion(v)}`,
    displayName: `Temurin ${formatVersion(v)}`,
    downloadUrl,
    checksum: { kind: 'sha256', url: `${downloadUrl}.json` },
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
