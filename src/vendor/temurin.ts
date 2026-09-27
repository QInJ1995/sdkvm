import type { ReleaseLine, ResolvedArtifact, Vendor } from './types.js';
import type { VendorPlatform } from './types.js';
import { httpJson, httpFetch } from '../net/http.js';
import { SdkvmError } from '../util/errors.js';
import { formatVersion, parseVersion } from '../core/version.js';

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
  const res = await httpFetch(url, { redirect: 'manual' });
  if (res.status !== 302 && res.status !== 307 && res.status !== 308) {
    throw new SdkvmError(`Adoptium API returned ${res.status} for JDK ${major}`);
  }
  const location = res.headers.get('location');
  if (!location) throw new SdkvmError(`Adoptium API returned no redirect for JDK ${major}`);
  return location;
}

/** GitHub release URL → 版本串。jdk-21.0.12.1%2B1 → 21.0.12.1+1 */
function versionFromGithubUrl(url: string): string {
  const m = /\/download\/jdk-([^/%]+(?:%2B[^/%]+)?)\//i.exec(url);
  if (!m || !m[1]) throw new SdkvmError(`Cannot parse version from Adoptium URL: ${url}`);
  return decodeURIComponent(m[1]);
}

function githubAssetUrl(version: string, os: string, arch: string): string {
  const v = parseVersion('temurin', version);
  const major = v.major;
  const ext = os === 'windows' ? 'zip' : 'tar.gz';
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
